import { requestUrl } from "obsidian";
import { consumeSSEStream } from "./sse";
import type {
	AgentMessage,
	AssistantTurn,
	ChatMessage,
	ChatOptions,
	ContentPart,
	Provider,
	TokenHandler,
	ToolCall,
	ToolDefinition,
} from "./types";
import { contentText, ToolsUnsupportedError } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const MAX_MODEL_PAGES = 5;

/** How much of an HTTP error body reaches a thrown message. */
const ERROR_BODY_CHARS = 300;

export interface AnthropicConfig {
	apiKey: string;
}

type AnthropicContentBlock =
	| { type: "text"; text: string }
	| {
			type: "image";
			source: { type: "base64"; media_type: string; data: string };
	  }
	| { type: "tool_use"; id: string; name: string; input: unknown }
	| {
			type: "tool_result";
			tool_use_id: string;
			content: string;
			is_error?: boolean;
	  };

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string | AnthropicContentBlock[];
}

interface AnthropicRequestBody {
	model: string;
	max_tokens: number;
	temperature?: number;
	top_p?: number;
	system?: string;
	messages: AnthropicMessage[];
	stream?: boolean;
	tools?: { name: string; description: string; input_schema: unknown }[];
}

/** Multimodal ChatMessage content → Anthropic content blocks. A plain string
 * passes through UNCHANGED so text-only request bodies stay byte-identical
 * to the pre-tools builds (regression-tested). */
function toAnthropicContent(
	content: string | ContentPart[],
): string | AnthropicContentBlock[] {
	if (typeof content === "string") return content;
	return content.map(
		(part): AnthropicContentBlock =>
			part.type === "text"
				? { type: "text", text: part.text }
				: {
						type: "image",
						source: {
							type: "base64",
							media_type: part.mimeType,
							data: part.base64,
						},
					},
	);
}

function splitSystem(messages: ChatMessage[]): {
	system: string | undefined;
	conversation: AnthropicMessage[];
} {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => contentText(message.content))
		.join("\n\n");

	const conversation = messages
		.filter(
			(message): message is ChatMessage & { role: "user" | "assistant" } =>
				message.role !== "system",
		)
		.map((message) => ({
			role: message.role,
			content: toAnthropicContent(message.content),
		}));

	return { system: system || undefined, conversation };
}

/** Tolerant parse of a tool call's raw argument JSON for the request replay
 * direction (assistant history → API). The API demands an object here; a
 * malformed blob becomes {} rather than a crash. */
function parseArgumentsForReplay(raw: string): unknown {
	if (raw.trim().length === 0) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/**
 * Converts a provider-neutral agent transcript to Anthropic messages:
 * assistant tool calls become `tool_use` blocks; consecutive tool results
 * merge into ONE following user message of `tool_result` blocks (the shape
 * the API requires — a tool_use must be answered in the next user turn).
 */
function toAnthropicAgentMessages(messages: AgentMessage[]): {
	system: string | undefined;
	conversation: AnthropicMessage[];
} {
	const systemParts: string[] = [];
	const conversation: AnthropicMessage[] = [];
	let pendingToolResults: AnthropicContentBlock[] = [];

	const flushToolResults = () => {
		if (pendingToolResults.length === 0) return;
		conversation.push({ role: "user", content: pendingToolResults });
		pendingToolResults = [];
	};

	for (const message of messages) {
		if (message.role === "tool") {
			pendingToolResults.push({
				type: "tool_result",
				tool_use_id: message.toolCallId,
				content: message.content,
				...(message.isError ? { is_error: true } : {}),
			});
			continue;
		}
		flushToolResults();

		if (message.role === "system") {
			systemParts.push(contentText(message.content));
			continue;
		}

		if (message.role === "assistant" && "toolCalls" in message) {
			const blocks: AnthropicContentBlock[] = [];
			if (message.content.length > 0) {
				blocks.push({ type: "text", text: message.content });
			}
			for (const call of message.toolCalls) {
				blocks.push({
					type: "tool_use",
					id: call.id,
					name: call.name,
					input: parseArgumentsForReplay(call.arguments),
				});
			}
			conversation.push({ role: "assistant", content: blocks });
			continue;
		}

		conversation.push({
			role: message.role,
			content: toAnthropicContent(message.content),
		});
	}
	flushToolResults();

	return {
		system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
		conversation,
	};
}

function toAnthropicTools(
	tools: ToolDefinition[],
): AnthropicRequestBody["tools"] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: tool.parameters,
	}));
}

/** True when an error status+body reads as "this endpoint/model rejects
 * tool definitions" rather than a transient failure. */
function looksToolsUnsupported(status: number, bodyText: string): boolean {
	return (
		(status === 400 || status === 404 || status === 422) &&
		/tool/i.test(bodyText)
	);
}

function extractErrorMessage(bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as {
			error?: { message?: string };
			detail?: string;
			message?: string;
		};
		return (
			parsed.error?.message ??
			parsed.detail ??
			parsed.message ??
			bodyText.slice(0, ERROR_BODY_CHARS)
		);
	} catch {
		return bodyText.slice(0, ERROR_BODY_CHARS);
	}
}

/**
 * Anthropic Messages API adapter. Anthropic takes `system` as a top-level
 * field rather than a message with role "system", so we extract it here.
 */
export class AnthropicProvider implements Provider {
	name = "anthropic";

	constructor(private config: AnthropicConfig) {}

	private headers(streaming: boolean): Record<string, string> {
		return {
			"x-api-key": this.config.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
			...(streaming
				? { "anthropic-dangerous-direct-browser-access": "true" }
				: {}),
			"content-type": "application/json",
		};
	}

	private buildBody(
		messages: ChatMessage[],
		opts: ChatOptions,
		stream: boolean,
	): AnthropicRequestBody {
		const { system, conversation } = splitSystem(messages);
		return {
			model: opts.model,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
			temperature: opts.temperature,
			top_p: opts.topP,
			system,
			messages: conversation,
			...(stream ? { stream: true } : {}),
		};
	}

	private buildAgentBody(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
		stream: boolean,
	): AnthropicRequestBody {
		const { system, conversation } = toAnthropicAgentMessages(messages);
		return {
			model: opts.model,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
			temperature: opts.temperature,
			top_p: opts.topP,
			system,
			messages: conversation,
			...(tools.length > 0 ? { tools: toAnthropicTools(tools) } : {}),
			...(stream ? { stream: true } : {}),
		};
	}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const response = await requestUrl({
			url: ANTHROPIC_API_URL,
			method: "POST",
			headers: this.headers(false),
			body: JSON.stringify(this.buildBody(messages, opts, false)),
			throw: false,
		});

		const data = response.json as
			| {
					content?: { text?: string }[];
					error?: { message?: string };
			  }
			| undefined;

		if (response.status >= 400) {
			const apiMsg = data?.error?.message;
			throw new Error(
				`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		const text = data?.content?.[0]?.text;
		if (typeof text === "string") return text;
		throw new Error(
			`Model "${opts.model}" returned an unexpected response shape.`,
		);
	}

	async chatWithTools(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
	): Promise<AssistantTurn> {
		const response = await requestUrl({
			url: ANTHROPIC_API_URL,
			method: "POST",
			headers: this.headers(false),
			body: JSON.stringify(this.buildAgentBody(messages, tools, opts, false)),
			throw: false,
		});

		const data = response.json as
			| {
					content?: {
						type?: string;
						text?: string;
						id?: string;
						name?: string;
						input?: unknown;
					}[];
					error?: { message?: string };
			  }
			| undefined;

		if (response.status >= 400) {
			const apiMsg = data?.error?.message ?? "";
			if (looksToolsUnsupported(response.status, apiMsg)) {
				throw new ToolsUnsupportedError(
					`Model "${opts.model}" rejected tool definitions: ${apiMsg}`,
				);
			}
			throw new Error(
				`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		let text = "";
		const toolCalls: ToolCall[] = [];
		for (const block of data?.content ?? []) {
			if (block.type === "text" && typeof block.text === "string") {
				text += block.text;
			} else if (
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				toolCalls.push({
					id: block.id,
					name: block.name,
					arguments: JSON.stringify(block.input ?? {}),
				});
			}
		}
		return { text, toolCalls };
	}

	async listModels(): Promise<string[]> {
		const ids: string[] = [];
		let afterId: string | undefined;

		for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
			const url = afterId
				? `${ANTHROPIC_MODELS_URL}?limit=1000&after_id=${encodeURIComponent(afterId)}`
				: `${ANTHROPIC_MODELS_URL}?limit=1000`;

			const response = await requestUrl({
				url,
				method: "GET",
				headers: {
					"x-api-key": this.config.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
				},
				throw: false,
			});

			const data = response.json as
				| {
						data?: { id?: string }[];
						has_more?: boolean;
						last_id?: string;
						error?: { message?: string };
				  }
				| undefined;

			if (response.status >= 400) {
				const apiMsg = data?.error?.message;
				throw new Error(
					`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
				);
			}

			for (const model of data?.data ?? []) {
				if (typeof model.id === "string") ids.push(model.id);
			}

			if (!data?.has_more || !data.last_id) break;
			afterId = data.last_id;
		}

		return ids;
	}

	async streamChat(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<string> {
		try {
			const response = await fetch(ANTHROPIC_API_URL, {
				method: "POST",
				headers: this.headers(true),
				body: JSON.stringify(this.buildBody(messages, opts, true)),
				signal: opts.signal,
			});

			if (!response.ok) {
				// Read the body for an honest reason (it's consumed either way);
				// truncated so provider detail can't flood a user-facing Notice.
				const bodyText = await response.text().catch(() => "");
				throw new Error(
					`Request failed: ${response.status}${bodyText ? ` — ${extractErrorMessage(bodyText)}` : ""}`,
				);
			}

			let full = "";
			let streamError: string | undefined;

			await consumeSSEStream(
				response,
				(data) => {
					let event: unknown;
					try {
						event = JSON.parse(data);
					} catch {
						return;
					}
					if (typeof event !== "object" || event === null) return;
					const parsed = event as {
						type?: string;
						delta?: { type?: string; text?: string };
						error?: { message?: string };
					};

					if (parsed.type === "error") {
						streamError = parsed.error?.message ?? "Anthropic stream error";
						return;
					}
					if (
						parsed.type === "content_block_delta" &&
						parsed.delta?.type === "text_delta" &&
						typeof parsed.delta.text === "string"
					) {
						full += parsed.delta.text;
						onToken(parsed.delta.text);
					}
				},
				opts.signal,
			);

			if (streamError) throw new Error(streamError);
			return full;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			// Fetch/CORS failure (or explicit stream error) — fall back to the
			// guaranteed non-streaming path and deliver the whole answer at once.
			const full = await this.chat(messages, opts);
			onToken(full);
			return full;
		}
	}

	async streamChatWithTools(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<AssistantTurn> {
		try {
			const response = await fetch(ANTHROPIC_API_URL, {
				method: "POST",
				headers: this.headers(true),
				body: JSON.stringify(this.buildAgentBody(messages, tools, opts, true)),
				signal: opts.signal,
			});

			if (!response.ok) {
				// The tools-unsupported decision NEEDS the body — the old
				// status-only throw hid exactly this signal.
				const bodyText = await response.text().catch(() => "");
				if (looksToolsUnsupported(response.status, bodyText)) {
					throw new ToolsUnsupportedError(
						`Model "${opts.model}" rejected tool definitions: ${extractErrorMessage(bodyText)}`,
					);
				}
				throw new Error(
					`Request failed: ${response.status}${bodyText ? ` — ${extractErrorMessage(bodyText)}` : ""}`,
				);
			}

			let text = "";
			let streamError: string | undefined;
			const toolCalls: ToolCall[] = [];
			// Accumulator for the tool_use block currently being streamed:
			// content_block_start carries id/name, input_json_delta carries
			// argument JSON fragments, content_block_stop finalizes.
			let openToolCall: { id: string; name: string; json: string } | null =
				null;

			await consumeSSEStream(
				response,
				(data) => {
					let event: unknown;
					try {
						event = JSON.parse(data);
					} catch {
						return;
					}
					if (typeof event !== "object" || event === null) return;
					const parsed = event as {
						type?: string;
						content_block?: { type?: string; id?: string; name?: string };
						delta?: { type?: string; text?: string; partial_json?: string };
						error?: { message?: string };
					};

					if (parsed.type === "error") {
						streamError = parsed.error?.message ?? "Anthropic stream error";
						return;
					}
					if (
						parsed.type === "content_block_start" &&
						parsed.content_block?.type === "tool_use" &&
						typeof parsed.content_block.id === "string" &&
						typeof parsed.content_block.name === "string"
					) {
						openToolCall = {
							id: parsed.content_block.id,
							name: parsed.content_block.name,
							json: "",
						};
						return;
					}
					if (
						parsed.type === "content_block_delta" &&
						parsed.delta?.type === "input_json_delta" &&
						typeof parsed.delta.partial_json === "string" &&
						openToolCall
					) {
						openToolCall.json += parsed.delta.partial_json;
						return;
					}
					if (parsed.type === "content_block_stop" && openToolCall) {
						toolCalls.push({
							id: openToolCall.id,
							name: openToolCall.name,
							arguments: openToolCall.json,
						});
						openToolCall = null;
						return;
					}
					if (
						parsed.type === "content_block_delta" &&
						parsed.delta?.type === "text_delta" &&
						typeof parsed.delta.text === "string"
					) {
						text += parsed.delta.text;
						onToken(parsed.delta.text);
					}
				},
				opts.signal,
			);

			if (streamError) throw new Error(streamError);
			return { text, toolCalls };
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			if (err instanceof ToolsUnsupportedError) throw err;
			// Fetch/CORS or stream-parse failure — retry non-streaming.
			return this.chatWithTools(messages, tools, opts);
		}
	}
}

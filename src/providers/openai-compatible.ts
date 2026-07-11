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
import { ReasoningOnlyError, ToolsUnsupportedError } from "./types";

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

/** How much of an HTTP error body reaches a thrown message. */
const ERROR_BODY_CHARS = 300;

export interface OpenAICompatibleConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * Validates a user-configurable provider base URL (OpenAI-compatible/Ollama)
 * before it's ever used to send a bearer key: requires a well-formed
 * `https://` URL, or `http://localhost`/`http://127.0.0.1` for a local Ollama
 * server. Rejects embedded credentials (`user:pass@host`), URL fragments,
 * and any other scheme. A mistyped or look-alike host must never silently
 * receive the configured API key.
 */
export function validateBaseUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid base URL: "${url}" is not a well-formed URL.`);
	}

	if (parsed.username || parsed.password) {
		throw new Error(
			`Invalid base URL: "${url}" must not contain embedded credentials.`,
		);
	}

	if (parsed.hash) {
		throw new Error(`Invalid base URL: "${url}" must not contain a fragment.`);
	}

	if (parsed.protocol === "https:") return;

	const isLocalHttp =
		parsed.protocol === "http:" &&
		(parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
	if (isLocalHttp) return;

	throw new Error(
		`Invalid base URL: "${url}" must use https:// (http:// is only allowed ` +
			"for localhost/127.0.0.1, e.g. a local Ollama server).",
	);
}

type OpenAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

/** Multimodal ChatMessage content → OpenAI content-part array. A plain
 * string passes through UNCHANGED so text-only request bodies stay
 * byte-identical to the pre-tools builds (regression-tested). */
function toOpenAIContent(
	content: string | ContentPart[],
): string | OpenAIContentPart[] {
	if (typeof content === "string") return content;
	return content.map(
		(part): OpenAIContentPart =>
			part.type === "text"
				? { type: "text", text: part.text }
				: {
						type: "image_url",
						image_url: {
							url: `data:${part.mimeType};base64,${part.base64}`,
						},
					},
	);
}

interface OpenAIToolCallPayload {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

type OpenAIMessage =
	| {
			role: "system" | "user" | "assistant";
			content: string | OpenAIContentPart[];
	  }
	| {
			role: "assistant";
			content: string | null;
			tool_calls: OpenAIToolCallPayload[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

/** Converts a provider-neutral agent transcript to OpenAI messages. */
function toOpenAIAgentMessages(messages: AgentMessage[]): OpenAIMessage[] {
	return messages.map((message): OpenAIMessage => {
		if (message.role === "tool") {
			return {
				role: "tool",
				tool_call_id: message.toolCallId,
				// OpenAI has no is_error flag — the framing text carries it.
				content: message.content,
			};
		}
		if (message.role === "assistant" && "toolCalls" in message) {
			return {
				role: "assistant",
				content: message.content.length > 0 ? message.content : null,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: call.arguments },
				})),
			};
		}
		return { role: message.role, content: toOpenAIContent(message.content) };
	});
}

function toOpenAITools(tools: ToolDefinition[]): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		},
	}));
}

/** True when an error status+body reads as "this endpoint/model rejects
 * tool definitions" (e.g. a NIM model without function calling) rather than
 * a transient failure. */
function looksToolsUnsupported(status: number, bodyText: string): boolean {
	return (
		(status === 400 || status === 404 || status === 422) &&
		/tool|function.?call/i.test(bodyText)
	);
}

/** Extra request-body fields + behavior overrides needed to work around
 * NIM-hosted DeepSeek v4's model-side quirks (opencode #24264, NVIDIA forum
 * #368085): the request must carry `chat_template_kwargs` to avoid hanging,
 * and streamed tool calls are unreliable so tool-calling turns run
 * non-streaming instead. Scoped to NIM specifically — an Ollama/OpenAI-hosted
 * DeepSeek must not get NIM's kwargs. */
interface NimDeepseekQuirks {
	extraBody: Record<string, unknown>;
	forceNonStreamingTools: true;
}

const DEEPSEEK_THINK_KWARGS = {
	chat_template_kwargs: { enable_thinking: true, thinking: true },
};

// TODO: kwargs shape unverified against NIM docs for the nonthink case —
// mirrors the think shape until confirmed live.
const DEEPSEEK_NONTHINK_KWARGS = {
	chat_template_kwargs: { enable_thinking: false, thinking: false },
};

function nimDeepseekQuirks(
	baseUrl: string,
	model: string,
	reasoning?: "think" | "nonthink",
): NimDeepseekQuirks | null {
	if (baseUrl !== NIM_BASE_URL) return null;
	if (!model.toLowerCase().startsWith("deepseek-ai/deepseek-v4")) return null;
	return {
		extraBody:
			reasoning === "nonthink"
				? DEEPSEEK_NONTHINK_KWARGS
				: DEEPSEEK_THINK_KWARGS,
		forceNonStreamingTools: true,
	};
}

/** Single-sourced message for a response that carried only reasoning tokens
 * and no usable answer text — used by both the non-streaming guard and the
 * streaming parsers. */
function reasoningOnlyError(model: string): ReasoningOnlyError {
	return new ReasoningOnlyError(
		`Model "${model}" returned only reasoning tokens and no answer text — try a standard chat model (e.g. meta/llama-3.3-70b-instruct).`,
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
 * Read requestUrl's JSON body without throwing. Obsidian's `.json` getter runs
 * JSON.parse on the raw body and throws a SyntaxError for any non-JSON response
 * (e.g. a 503 rate-limit page). Unguarded, that SyntaxError propagated to the
 * chat UI as a cryptic "JSON error". Returns undefined on failure so callers
 * fall through to status-based handling using the raw body text.
 */
function safeJson<T>(response: { json: unknown }): T | undefined {
	try {
		return response.json as T;
	} catch {
		return undefined;
	}
}

/** Raw streamed `delta.tool_calls` fragment: OpenAI splits one call's id/
 * name/argument JSON across many chunks, keyed by array index. */
interface ToolCallFragment {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
}

/** Accumulates streamed tool-call fragments (keyed by index) into whole calls. */
export class ToolCallAssembler {
	private fragments = new Map<
		number,
		{ id: string; name: string; arguments: string }
	>();

	push(fragment: ToolCallFragment): void {
		const index = fragment.index ?? 0;
		const existing = this.fragments.get(index) ?? {
			id: "",
			name: "",
			arguments: "",
		};
		if (typeof fragment.id === "string" && fragment.id.length > 0) {
			existing.id = fragment.id;
		}
		if (typeof fragment.function?.name === "string") {
			existing.name += fragment.function.name;
		}
		if (typeof fragment.function?.arguments === "string") {
			existing.arguments += fragment.function.arguments;
		}
		this.fragments.set(index, existing);
	}

	finish(): ToolCall[] {
		return Array.from(this.fragments.entries())
			.sort(([a], [b]) => a - b)
			.map(([index, fragment]) => ({
				id: fragment.id || `call_${index}`,
				name: fragment.name,
				arguments: fragment.arguments,
			}))
			.filter((call) => call.name.length > 0);
	}
}

/**
 * Provider adapter for any OpenAI-compatible `/chat/completions` endpoint
 * (NVIDIA NIM, Ollama, OpenAI itself).
 */
export class OpenAICompatibleProvider implements Provider {
	name = "openai-compatible";

	constructor(private config: OpenAICompatibleConfig) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		validateBaseUrl(this.config.baseUrl);
		const quirks = nimDeepseekQuirks(
			this.config.baseUrl,
			opts.model,
			opts.reasoning,
		);
		const response = await requestUrl({
			url: `${this.config.baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: opts.model,
				messages: messages.map((message) => ({
					role: message.role,
					content: toOpenAIContent(message.content),
				})),
				max_tokens: opts.maxTokens,
				temperature: opts.temperature,
				top_p: opts.topP,
				seed: opts.seed,
				...(quirks?.extraBody ?? {}),
			}),
			throw: false,
		});

		const data = safeJson<{
			choices?: {
				message?: { content?: string; reasoning_content?: string };
			}[];
			error?: { message?: string };
			detail?: string;
			message?: string;
		}>(response);

		if (response.status >= 400) {
			const apiMsg =
				data?.error?.message ??
				data?.detail ??
				data?.message ??
				extractErrorMessage(response.text);
			throw new Error(
				`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		const content = data?.choices?.[0]?.message?.content;
		if (typeof content === "string" && content.length > 0) return content;

		// 200 OK but no usable text — surface WHY instead of crashing on undefined.
		if (data?.choices?.[0]?.message?.reasoning_content) {
			throw reasoningOnlyError(opts.model);
		}
		if (!data?.choices?.length) {
			throw new Error(
				`Model "${opts.model}" returned no choices. It may be a non-chat (vision/image) model or incompatible with the chat endpoint.`,
			);
		}
		throw new Error(`Model "${opts.model}" returned an empty response.`);
	}

	async chatWithTools(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
	): Promise<AssistantTurn> {
		validateBaseUrl(this.config.baseUrl);
		const quirks = nimDeepseekQuirks(
			this.config.baseUrl,
			opts.model,
			opts.reasoning,
		);
		const response = await requestUrl({
			url: `${this.config.baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: opts.model,
				messages: toOpenAIAgentMessages(messages),
				max_tokens: opts.maxTokens,
				temperature: opts.temperature,
				top_p: opts.topP,
				seed: opts.seed,
				...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
				...(quirks?.extraBody ?? {}),
			}),
			throw: false,
		});

		const data = safeJson<{
			choices?: {
				message?: {
					content?: string | null;
					tool_calls?: {
						id?: string;
						function?: { name?: string; arguments?: string };
					}[];
				};
			}[];
			error?: { message?: string };
			detail?: string;
			message?: string;
		}>(response);

		if (response.status >= 400) {
			const apiMsg =
				data?.error?.message ??
				data?.detail ??
				data?.message ??
				extractErrorMessage(response.text);
			if (looksToolsUnsupported(response.status, apiMsg)) {
				throw new ToolsUnsupportedError(
					`Model "${opts.model}" rejected tool definitions: ${apiMsg}`,
				);
			}
			throw new Error(
				`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		const message = data?.choices?.[0]?.message;
		const toolCalls: ToolCall[] = [];
		let counter = 0;
		for (const call of message?.tool_calls ?? []) {
			if (typeof call.function?.name !== "string") continue;
			counter += 1;
			toolCalls.push({
				id:
					typeof call.id === "string" && call.id ? call.id : `call_${counter}`,
				name: call.function.name,
				arguments: call.function.arguments ?? "",
			});
		}
		const content = typeof message?.content === "string" ? message.content : "";
		// Thinking models (e.g. GLM) can return only reasoning tokens — empty
		// content and no tool calls. Surface that instead of a silent blank
		// answer (mirrors chat() and streamChatWithTools()).
		if (
			content.length === 0 &&
			toolCalls.length === 0 &&
			(message as { reasoning_content?: string })?.reasoning_content
		) {
			throw reasoningOnlyError(opts.model);
		}
		return { text: content, toolCalls };
	}

	async listModels(): Promise<string[]> {
		validateBaseUrl(this.config.baseUrl);
		const response = await requestUrl({
			url: `${this.config.baseUrl}/models`,
			method: "GET",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
			},
			throw: false,
		});

		const data = safeJson<{
			data?: { id?: string }[];
			error?: { message?: string };
			detail?: string;
			message?: string;
		}>(response);

		if (response.status >= 400) {
			const apiMsg =
				data?.error?.message ??
				data?.detail ??
				data?.message ??
				extractErrorMessage(response.text);
			throw new Error(
				`Provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		const ids = (data?.data ?? [])
			.map((model) => model.id)
			.filter((id): id is string => typeof id === "string");

		return ids.sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" }),
		);
	}

	async streamChat(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<string> {
		validateBaseUrl(this.config.baseUrl);
		const quirks = nimDeepseekQuirks(
			this.config.baseUrl,
			opts.model,
			opts.reasoning,
		);
		try {
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: opts.model,
					messages: messages.map((message) => ({
						role: message.role,
						content: toOpenAIContent(message.content),
					})),
					max_tokens: opts.maxTokens,
					temperature: opts.temperature,
					top_p: opts.topP,
					seed: opts.seed,
					stream: true,
					...(quirks?.extraBody ?? {}),
				}),
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
			let sawReasoning = false;

			await consumeSSEStream(
				response,
				(data) => {
					if (data === "[DONE]") return;
					let event: unknown;
					try {
						event = JSON.parse(data);
					} catch {
						return;
					}
					if (typeof event !== "object" || event === null) return;
					const parsed = event as {
						choices?: {
							delta?: { content?: string; reasoning_content?: string };
						}[];
					};
					const delta = parsed.choices?.[0]?.delta;
					const token = delta?.content;
					if (typeof token === "string" && token.length > 0) {
						full += token;
						onToken(token);
					}
					if (
						typeof delta?.reasoning_content === "string" &&
						delta.reasoning_content.length > 0
					) {
						sawReasoning = true;
					}
				},
				opts.signal,
			);

			if (full.length === 0 && sawReasoning) {
				throw reasoningOnlyError(opts.model);
			}

			return full;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			if (err instanceof ReasoningOnlyError) throw err;
			// Fetch/CORS failure — fall back to the guaranteed non-streaming path
			// and deliver the whole answer at once.
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
		validateBaseUrl(this.config.baseUrl);
		const quirks = nimDeepseekQuirks(
			this.config.baseUrl,
			opts.model,
			opts.reasoning,
		);
		if (quirks?.forceNonStreamingTools) {
			// NIM's DeepSeek v4 streaming tool calls are unreliable model-side
			// (NVIDIA forum #368085) — delegate to the guaranteed non-streaming
			// path and deliver the whole answer through one onToken call.
			const turn = await this.chatWithTools(messages, tools, opts);
			if (turn.text.length > 0) onToken(turn.text);
			return turn;
		}
		try {
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: opts.model,
					messages: toOpenAIAgentMessages(messages),
					max_tokens: opts.maxTokens,
					temperature: opts.temperature,
					top_p: opts.topP,
					seed: opts.seed,
					...(tools.length > 0 ? { tools: toOpenAITools(tools) } : {}),
					stream: true,
				}),
				signal: opts.signal,
			});

			if (!response.ok) {
				// The tools-unsupported decision NEEDS the body — the old
				// status-only throw hid exactly this signal (NIM answers 400
				// with a tools message for non-function-calling models).
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
			let sawReasoning = false;
			const assembler = new ToolCallAssembler();

			await consumeSSEStream(
				response,
				(data) => {
					if (data === "[DONE]") return;
					let event: unknown;
					try {
						event = JSON.parse(data);
					} catch {
						return;
					}
					if (typeof event !== "object" || event === null) return;
					const parsed = event as {
						choices?: {
							delta?: {
								content?: string;
								reasoning_content?: string;
								tool_calls?: ToolCallFragment[];
							};
						}[];
					};
					const delta = parsed.choices?.[0]?.delta;
					if (!delta) return;
					if (typeof delta.content === "string" && delta.content.length > 0) {
						text += delta.content;
						onToken(delta.content);
					}
					if (
						typeof delta.reasoning_content === "string" &&
						delta.reasoning_content.length > 0
					) {
						sawReasoning = true;
					}
					for (const fragment of delta.tool_calls ?? []) {
						assembler.push(fragment);
					}
				},
				opts.signal,
			);

			const toolCalls = assembler.finish();
			if (text.length === 0 && toolCalls.length === 0 && sawReasoning) {
				throw reasoningOnlyError(opts.model);
			}

			return { text, toolCalls };
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			if (err instanceof ToolsUnsupportedError) throw err;
			if (err instanceof ReasoningOnlyError) throw err;
			// Fetch/CORS or stream-parse failure — retry non-streaming.
			return this.chatWithTools(messages, tools, opts);
		}
	}
}

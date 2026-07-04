import { requestUrl } from "obsidian";
import { consumeSSEStream } from "./sse";
import type { ChatMessage, ChatOptions, Provider, TokenHandler } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
	apiKey: string;
}

interface AnthropicRequestBody {
	model: string;
	max_tokens: number;
	system?: string;
	messages: { role: "user" | "assistant"; content: string }[];
	stream?: boolean;
}

function splitSystem(messages: ChatMessage[]): {
	system: string | undefined;
	conversation: { role: "user" | "assistant"; content: string }[];
} {
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n\n");

	const conversation = messages
		.filter(
			(message): message is ChatMessage & { role: "user" | "assistant" } =>
				message.role !== "system",
		)
		.map((message) => ({ role: message.role, content: message.content }));

	return { system: system || undefined, conversation };
}

/**
 * Anthropic Messages API adapter. Anthropic takes `system` as a top-level
 * field rather than a message with role "system", so we extract it here.
 */
export class AnthropicProvider implements Provider {
	name = "anthropic";

	constructor(private config: AnthropicConfig) {}

	private buildBody(
		messages: ChatMessage[],
		opts: ChatOptions,
		stream: boolean,
	): AnthropicRequestBody {
		const { system, conversation } = splitSystem(messages);
		return {
			model: opts.model,
			max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
			system,
			messages: conversation,
			...(stream ? { stream: true } : {}),
		};
	}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const response = await requestUrl({
			url: ANTHROPIC_API_URL,
			method: "POST",
			headers: {
				"x-api-key": this.config.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"content-type": "application/json",
			},
			body: JSON.stringify(this.buildBody(messages, opts, false)),
		});

		return response.json.content[0].text;
	}

	async streamChat(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<string> {
		try {
			const response = await fetch(ANTHROPIC_API_URL, {
				method: "POST",
				headers: {
					"x-api-key": this.config.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
					"anthropic-dangerous-direct-browser-access": "true",
					"content-type": "application/json",
				},
				body: JSON.stringify(this.buildBody(messages, opts, true)),
				signal: opts.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`Anthropic request failed (${response.status}): ${errorBody || response.statusText}`,
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
}

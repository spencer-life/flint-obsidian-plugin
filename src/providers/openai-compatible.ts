import { requestUrl } from "obsidian";
import { consumeSSEStream } from "./sse";
import type { ChatMessage, ChatOptions, Provider, TokenHandler } from "./types";

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface OpenAICompatibleConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * Provider adapter for any OpenAI-compatible `/chat/completions` endpoint
 * (NVIDIA NIM, Ollama, OpenAI itself).
 */
export class OpenAICompatibleProvider implements Provider {
	name = "openai-compatible";

	constructor(private config: OpenAICompatibleConfig) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const response = await requestUrl({
			url: `${this.config.baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: opts.model,
				messages,
				max_tokens: opts.maxTokens,
			}),
		});

		return response.json.choices[0].message.content;
	}

	async streamChat(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<string> {
		try {
			const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.apiKey}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model: opts.model,
					messages,
					max_tokens: opts.maxTokens,
					stream: true,
				}),
				signal: opts.signal,
			});

			if (!response.ok) {
				const errorBody = await response.text().catch(() => "");
				throw new Error(
					`Request failed (${response.status}): ${errorBody || response.statusText}`,
				);
			}

			let full = "";

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
						choices?: { delta?: { content?: string } }[];
					};
					const token = parsed.choices?.[0]?.delta?.content;
					if (typeof token === "string" && token.length > 0) {
						full += token;
						onToken(token);
					}
				},
				opts.signal,
			);

			return full;
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") throw err;
			// Fetch/CORS failure — fall back to the guaranteed non-streaming path
			// and deliver the whole answer at once.
			const full = await this.chat(messages, opts);
			onToken(full);
			return full;
		}
	}
}

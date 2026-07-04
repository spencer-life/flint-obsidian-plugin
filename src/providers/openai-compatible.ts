import { requestUrl } from "obsidian";
import { consumeSSEStream } from "./sse";
import type { ChatMessage, ChatOptions, Provider, TokenHandler } from "./types";

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

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

/**
 * Provider adapter for any OpenAI-compatible `/chat/completions` endpoint
 * (NVIDIA NIM, Ollama, OpenAI itself).
 */
export class OpenAICompatibleProvider implements Provider {
	name = "openai-compatible";

	constructor(private config: OpenAICompatibleConfig) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		validateBaseUrl(this.config.baseUrl);
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
		validateBaseUrl(this.config.baseUrl);
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
				// Deliberately don't include the response body in the thrown
				// message: it can contain provider-specific error detail we don't
				// want surfacing verbatim in a user-facing Notice.
				throw new Error(`Request failed: ${response.status}`);
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

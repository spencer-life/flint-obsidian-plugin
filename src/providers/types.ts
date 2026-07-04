export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	model: string;
	maxTokens?: number;
	signal?: AbortSignal;
}

export type TokenHandler = (token: string) => void;

export interface Provider {
	name: string;
	/** Non-streaming call via `requestUrl` — the guaranteed fallback on every platform. */
	chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
	/**
	 * Streaming call via `fetch` + SSE. Calls `onToken` for each incremental
	 * chunk of text and resolves with the full assembled answer. If the
	 * underlying `fetch` throws (e.g. CORS failure on some platforms), this
	 * falls back to the non-streaming `chat()` and delivers the whole answer
	 * through a single `onToken` call.
	 */
	streamChat(
		messages: ChatMessage[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<string>;
}

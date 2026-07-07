/** One part of a multimodal message: plain text or an inline base64 image. */
export type ContentPart =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; base64: string };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string | ContentPart[];
}

/** Flattens message content to plain text (image parts are dropped) — for
 * paths that only ever handle text, e.g. system-prompt assembly. */
export function contentText(content: string | ContentPart[]): string {
	if (typeof content === "string") return content;
	return content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("\n");
}

/** A tool the model may call, in provider-neutral shape. `parameters` is a
 * JSON Schema object describing the arguments. */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** One tool invocation emitted by the model. `arguments` is the raw JSON
 * string as the provider delivered it — parsing is the caller's job so a
 * malformed blob can become a tool-result error instead of a crash. */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

/** One assistant turn from a tool-capable chat call: any streamed/returned
 * text plus zero or more tool calls to satisfy before the next turn. */
export interface AssistantTurn {
	text: string;
	toolCalls: ToolCall[];
}

/**
 * Provider-facing agent transcript entry. A plain ChatMessage, an assistant
 * turn that carried tool calls, or a tool result answering one call by id.
 * Every tool call in the transcript MUST be answered by a tool message
 * before the next model call — both APIs reject dangling calls.
 */
export type AgentMessage =
	| ChatMessage
	| { role: "assistant"; content: string; toolCalls: ToolCall[] }
	| { role: "tool"; toolCallId: string; content: string; isError?: boolean };

/** Thrown when the configured model/endpoint rejects tool definitions
 * outright (e.g. a NIM model without function-calling support) — callers
 * degrade to the plain RAG pipeline instead of failing the send. */
export class ToolsUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ToolsUnsupportedError";
	}
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
	/** Non-streaming tool-capable call. Throws `ToolsUnsupportedError` when
	 * the endpoint rejects the tool definitions themselves. */
	chatWithTools(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
	): Promise<AssistantTurn>;
	/**
	 * Streaming tool-capable call: text deltas arrive through `onToken`; tool
	 * calls are assembled whole and only returned in the resolved turn. Falls
	 * back to `chatWithTools` on fetch/stream-parse failure (but NOT on
	 * `ToolsUnsupportedError` or abort, which propagate).
	 */
	streamChatWithTools(
		messages: AgentMessage[],
		tools: ToolDefinition[],
		opts: ChatOptions,
		onToken: TokenHandler,
	): Promise<AssistantTurn>;
	/** Lists model ids available to this provider's configured key, in API order. */
	listModels(): Promise<string[]>;
}

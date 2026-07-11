import type { AgentMessage, ChatMessage } from "../providers/types";
import { contentText } from "../providers/types";

/**
 * Outbound budget (approx. character count) for the conversation/agent
 * transcript sent to the model on each turn — independent of what's kept in
 * the UI. Bounds token cost/latency on long-running chats without touching
 * what's rendered in the panel.
 */
export const OUTBOUND_TRANSCRIPT_BUDGET_CHARS = 24_000;

/** A provider HTTP status embedded by our own error formatting
 * (`Provider error (NNN): ...` / `Request failed: NNN — ...`, used by every
 * provider in `src/providers/`). */
function extractProviderStatus(message: string): number | undefined {
	const match = message.match(
		/(?:Provider error \((\d{3})\)|Request failed:\s*(\d{3}))/,
	);
	const raw = match?.[1] ?? match?.[2];
	return raw ? Number(raw) : undefined;
}

/**
 * Maps a thrown error to concise, actionable panel copy. Recognizes request
 * timeouts (`RequestTimeoutError` from `src/providers/deadline.ts`),
 * network/CORS failures, vision/image rejections, 404s, auth failures
 * (401/403), rate limits (429), and provider 5xx errors; falls back to the
 * raw message for anything else.
 */
export function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	const name = err instanceof Error ? err.name : undefined;

	if (name === "RequestTimeoutError") {
		return `The model didn't respond in time — try again or switch models. (${message})`;
	}
	if (/image|vision|multimodal|multi-modal/i.test(message)) {
		return `This model can't read images — try a vision-capable model. (${message})`;
	}
	if (/failed to fetch/i.test(message)) {
		return "Network/CORS error reaching the provider — check your connection.";
	}
	if (/\b404\b/.test(message)) {
		return `Model not found (404) — check the model id. Some provider models are deprecated or renamed. (${message})`;
	}

	const status = extractProviderStatus(message);
	if (status === 401 || status === 403) {
		return `Auth failed — check your API key in settings. (${message})`;
	}
	if (status === 429) {
		return `Rate limited by the provider — wait a moment and retry. (${message})`;
	}
	if (status !== undefined && status >= 500) {
		return `Provider server error — try again. (${message})`;
	}
	if (/unexpected token|is not valid json|json parse error/i.test(message)) {
		return `The provider returned a malformed response — try again. (${message})`;
	}
	return message;
}

/** Rough outbound size of one agent-transcript entry, in characters. Tool
 * calls' JSON arguments are included since they're replayed to the model on
 * every later turn just like the result text. */
function agentMessageChars(message: AgentMessage): number {
	if (message.role === "tool") return message.content.length;
	if ("toolCalls" in message) {
		const toolChars = message.toolCalls.reduce(
			(sum, call) => sum + call.name.length + call.arguments.length,
			0,
		);
		return message.content.length + toolChars;
	}
	return contentText(message.content).length;
}

/**
 * Trims the agent transcript to an outbound character budget, dropping
 * whole OLDEST turns first — never splitting a turn — so every tool call
 * keeps its matching tool result (a partial turn would 400 on the next
 * model call). A "turn" is a user message plus everything the model/tools
 * did in response, up to (not including) the next user message. The
 * newest turn is always kept in full, even alone over budget, so the
 * user's latest intent is never dropped.
 */
export function budgetAgentTranscript(
	transcript: AgentMessage[],
	maxChars: number = OUTBOUND_TRANSCRIPT_BUDGET_CHARS,
): AgentMessage[] {
	const turns: AgentMessage[][] = [];
	for (const message of transcript) {
		const current = turns[turns.length - 1];
		if (message.role === "user" || !current) {
			turns.push([message]);
		} else {
			current.push(message);
		}
	}

	let total = 0;
	const kept: AgentMessage[][] = [];
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		const turn = turns[i];
		if (!turn) continue;
		const size = turn.reduce((sum, m) => sum + agentMessageChars(m), 0);
		if (kept.length > 0 && total + size > maxChars) break;
		kept.unshift(turn);
		total += size;
	}
	return kept.flat();
}

/**
 * Trims RAG conversation history to an outbound character budget, dropping
 * oldest messages first. The newest message is always kept even alone over
 * budget, so the latest turn is never dropped.
 */
export function budgetChatHistory(
	history: ChatMessage[],
	maxChars: number = OUTBOUND_TRANSCRIPT_BUDGET_CHARS,
): ChatMessage[] {
	let total = 0;
	const kept: ChatMessage[] = [];
	for (let i = history.length - 1; i >= 0; i -= 1) {
		const message = history[i];
		if (!message) continue;
		const size = contentText(message.content).length;
		if (kept.length > 0 && total + size > maxChars) break;
		kept.unshift(message);
		total += size;
	}
	return kept;
}

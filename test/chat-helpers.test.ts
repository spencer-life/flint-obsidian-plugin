import { describe, expect, test } from "bun:test";
import type {
	AgentMessage,
	ChatMessage,
	ToolCall,
} from "../src/providers/types";
import {
	budgetAgentTranscript,
	budgetChatHistory,
	describeError,
	OUTBOUND_TRANSCRIPT_BUDGET_CHARS,
} from "../src/react/chat-helpers";

describe("describeError", () => {
	test("maps RequestTimeoutError to an actionable message", () => {
		const err = new Error("Chat request timed out after 30s — no response.");
		err.name = "RequestTimeoutError";
		expect(describeError(err)).toContain("didn't respond in time");
	});

	test("maps Failed to fetch to a network/CORS message", () => {
		const err = new TypeError("Failed to fetch");
		expect(describeError(err)).toBe(
			"Network/CORS error reaching the provider — check your connection.",
		);
	});

	test("keeps the existing vision special-case", () => {
		const err = new Error("This model does not support image inputs");
		expect(describeError(err)).toContain("can't read images");
	});

	test("keeps the existing 404 special-case", () => {
		const err = new Error("Provider error (404): model not found");
		expect(describeError(err)).toContain("Model not found (404)");
	});

	test("maps 401 to an auth-failed message", () => {
		const err = new Error("Provider error (401): invalid api key");
		expect(describeError(err)).toContain("Auth failed");
	});

	test("maps 403 to an auth-failed message", () => {
		const err = new Error("Request failed: 403 — forbidden");
		expect(describeError(err)).toContain("Auth failed");
	});

	test("maps 429 to a rate-limit message", () => {
		const err = new Error("Provider error (429): too many requests");
		expect(describeError(err)).toContain("Rate limited");
	});

	test("maps 5xx to a provider server error message", () => {
		const err = new Error("Provider error (503): service unavailable");
		expect(describeError(err)).toContain("Provider server error");
	});

	test("maps malformed JSON bodies to a friendly message", () => {
		const err = new SyntaxError("Unexpected token < in JSON at position 0");
		expect(describeError(err)).toContain("malformed response");
	});

	test("falls back to the raw message for anything unrecognized", () => {
		const err = new Error("something bespoke went wrong");
		expect(describeError(err)).toBe("something bespoke went wrong");
	});

	test("handles non-Error throws", () => {
		expect(describeError("plain string failure")).toBe("plain string failure");
	});
});

describe("budgetChatHistory", () => {
	function msg(role: ChatMessage["role"], text: string): ChatMessage {
		return { role, content: text };
	}

	test("returns everything when under budget", () => {
		const history = [msg("user", "hi"), msg("assistant", "hello")];
		expect(budgetChatHistory(history, 1000)).toEqual(history);
	});

	test("drops oldest messages first when over budget", () => {
		const history = [
			msg("user", "a".repeat(50)),
			msg("assistant", "b".repeat(50)),
			msg("user", "c".repeat(50)),
			msg("assistant", "d".repeat(50)),
		];
		const kept = budgetChatHistory(history, 120);
		expect(kept).toEqual(history.slice(2));
	});

	test("always keeps the newest message even alone over budget", () => {
		const newest = msg("assistant", "b".repeat(500));
		const history = [msg("user", "a".repeat(50)), newest];
		const kept = budgetChatHistory(history, 10);
		expect(kept).toEqual([newest]);
	});

	test("default budget constant is applied when omitted", () => {
		const history = [msg("user", "hi")];
		expect(budgetChatHistory(history)).toEqual(history);
		expect(OUTBOUND_TRANSCRIPT_BUDGET_CHARS).toBeGreaterThan(0);
	});
});

describe("budgetAgentTranscript", () => {
	function call(id: string): ToolCall {
		return { id, name: "read_note", arguments: "{}" };
	}

	function turn(userText: string, toolResultText = ""): AgentMessage[] {
		const id = `call-${userText.slice(0, 8)}`;
		return [
			{ role: "user", content: userText },
			{ role: "assistant", content: "", toolCalls: [call(id)] },
			{ role: "tool", toolCallId: id, content: toolResultText },
			{ role: "assistant", content: `done: ${userText}`, toolCalls: [] },
		];
	}

	test("returns everything when under budget", () => {
		const transcript = turn("first");
		expect(budgetAgentTranscript(transcript, 10_000)).toEqual(transcript);
	});

	test("drops whole oldest turns first, never splitting a turn", () => {
		const t1 = turn("first turn", "x".repeat(100));
		const t2 = turn("second turn", "y".repeat(100));
		const transcript = [...t1, ...t2];

		// Budget only large enough for the newest turn.
		const kept = budgetAgentTranscript(transcript, 150);
		expect(kept).toEqual(t2);

		// Every tool call in the kept transcript has a matching tool result.
		const callIds = kept
			.filter(
				(
					m,
				): m is Extract<AgentMessage, { role: "assistant" }> & {
					toolCalls: ToolCall[];
				} => "toolCalls" in m,
			)
			.flatMap((m) => m.toolCalls.map((c) => c.id));
		const resultIds = kept
			.filter(
				(m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool",
			)
			.map((m) => m.toolCallId);
		expect(new Set(resultIds)).toEqual(new Set(callIds));
	});

	test("always keeps the newest turn intact even alone over budget", () => {
		const t1 = turn("first turn");
		const t2 = turn("second turn", "z".repeat(10_000));
		const transcript = [...t1, ...t2];

		const kept = budgetAgentTranscript(transcript, 10);
		expect(kept).toEqual(t2);
	});

	test("default budget constant is applied when omitted", () => {
		const transcript = turn("hi");
		expect(budgetAgentTranscript(transcript)).toEqual(transcript);
	});
});

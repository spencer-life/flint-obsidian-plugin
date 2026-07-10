import { describe, expect, test } from "bun:test";
import "./obsidian-mock";
import type {
	AgentMessage,
	AssistantTurn,
	ChatOptions,
	Provider,
	ToolCall,
} from "../src/providers/types";

const { runAgentLoop } = await import("../src/agent/loop");

/** Provider stub that replays scripted turns and records every transcript
 * it was called with. Repeats the last turn if called more often than
 * scripted (for cap tests). */
function scriptedProvider(turns: AssistantTurn[]): Provider & {
	transcripts: AgentMessage[][];
} {
	let index = 0;
	const transcripts: AgentMessage[][] = [];
	const next = (messages: AgentMessage[]): AssistantTurn => {
		transcripts.push([...messages]);
		const turn = turns[Math.min(index, turns.length - 1)];
		index += 1;
		if (!turn) throw new Error("no scripted turn");
		return turn;
	};
	return {
		name: "scripted",
		transcripts,
		chat: async () => "unused",
		streamChat: async () => "unused",
		listModels: async () => [],
		chatWithTools: async (messages) => next(messages),
		streamChatWithTools: async (messages) => next(messages),
	};
}

function call(id: string, name: string, args = "{}"): ToolCall {
	return { id, name, arguments: args };
}

/** Executor stub recording calls; returns a canned result. */
function recordingExecutor(result = "ok") {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	return {
		calls,
		execute: async (name: string, args: Record<string, unknown>) => {
			calls.push({ name, args });
			return { content: result, isError: false };
		},
	};
}

function toolMessages(messages: AgentMessage[]) {
	return messages.filter(
		(m): m is Extract<AgentMessage, { role: "tool" }> => m.role === "tool",
	);
}

describe("runAgentLoop", () => {
	test("read-only calls execute without confirmation; final text returned", async () => {
		const provider = scriptedProvider([
			{ text: "", toolCalls: [call("t1", "read_note", '{"path":"A.md"}')] },
			{ text: "All done.", toolCalls: [] },
		]);
		const executor = recordingExecutor("note content");
		let confirmations = 0;

		const result = await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "read A" }],
			tools: [],
			executor,
			stream: false,
			events: {
				requestConfirmation: async () => {
					confirmations += 1;
					return "apply";
				},
			},
		});

		expect(result.text).toBe("All done.");
		expect(confirmations).toBe(0);
		expect(executor.calls).toEqual([
			{ name: "read_note", args: { path: "A.md" } },
		]);
		const tools = toolMessages(result.appended);
		expect(tools).toHaveLength(1);
		expect(tools[0]?.toolCallId).toBe("t1");
		expect(tools[0]?.content).toContain("note content");
		expect(tools[0]?.content).toContain("untrusted");
	});

	test("apply executes the mutation; skip synthesizes a declined result without executing", async () => {
		const provider = scriptedProvider([
			{
				text: "",
				toolCalls: [
					call("t1", "move_note", '{"path":"A.md","destination":"01"}'),
					call("t2", "move_note", '{"path":"B.md","destination":"01"}'),
				],
			},
			{ text: "Done.", toolCalls: [] },
		]);
		const executor = recordingExecutor("moved");
		const decisions: ("apply" | "skip")[] = ["apply", "skip"];

		const result = await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "move" }],
			tools: [],
			executor,
			stream: false,
			events: {
				requestConfirmation: async () => decisions.shift() ?? "skip",
			},
		});

		expect(executor.calls).toHaveLength(1);
		expect(executor.calls[0]?.args).toEqual({
			path: "A.md",
			destination: "01",
		});
		const tools = toolMessages(result.appended);
		expect(tools).toHaveLength(2);
		expect(tools[0]?.content).toContain("moved");
		expect(tools[1]?.content).toContain("declined");
		expect(tools[1]?.isError).toBe(true);
	});

	test("abort while awaiting confirmation: synthetic results for ALL outstanding calls, then AbortError", async () => {
		const controller = new AbortController();
		const provider = scriptedProvider([
			{
				text: "",
				toolCalls: [
					call("t1", "create_note", "{}"),
					call("t2", "create_note", "{}"),
				],
			},
		]);
		const executor = recordingExecutor();
		const syntheticResults: string[] = [];

		const run = runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "go" }],
			tools: [],
			executor,
			stream: false,
			signal: controller.signal,
			events: {
				requestConfirmation: () =>
					new Promise(() => {
						// Never resolves — the user walked away; abort must win.
						controller.abort();
					}),
				onToolResult: (_call, result) => {
					syntheticResults.push(result.content);
				},
			},
		});

		await expect(run).rejects.toMatchObject({ name: "AbortError" });
		expect(executor.calls).toHaveLength(0);
		// BOTH outstanding calls got synthetic "cancelled" results.
		expect(syntheticResults).toHaveLength(2);
		for (const content of syntheticResults) {
			expect(content).toContain("cancelled");
		}
	});

	test("invalid tool arguments become an error result, not a crash", async () => {
		const provider = scriptedProvider([
			{ text: "", toolCalls: [call("t1", "read_note", "{broken")] },
			{ text: "ok", toolCalls: [] },
		]);
		const executor = recordingExecutor();

		const result = await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "go" }],
			tools: [],
			executor,
			stream: false,
			events: { requestConfirmation: async () => "apply" },
		});

		expect(executor.calls).toHaveLength(0);
		const tools = toolMessages(result.appended);
		expect(tools[0]?.isError).toBe(true);
		expect(tools[0]?.content).toContain("Invalid arguments");
	});

	test("iteration cap forces a final summary; every emitted call is answered", async () => {
		// The model never stops calling tools.
		const provider = scriptedProvider([
			{ text: "", toolCalls: [call("t", "read_note", '{"path":"A.md"}')] },
		]);
		const executor = recordingExecutor();

		const result = await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "go" }],
			tools: [],
			executor,
			stream: false,
			events: { requestConfirmation: async () => "apply" },
		});

		// 8 tool iterations + 1 forced summary call.
		expect(provider.transcripts).toHaveLength(9);
		// The forced summary's user nudge is in the final transcript.
		const lastTranscript = provider.transcripts[8] ?? [];
		const lastUser = lastTranscript[lastTranscript.length - 1];
		expect(lastUser?.role).toBe("user");
		// Every assistant tool call in the appended transcript has a matching
		// tool result (the invariant both APIs enforce).
		const calls: string[] = [];
		for (const message of result.appended) {
			if (message.role === "assistant" && "toolCalls" in message) {
				calls.push(...message.toolCalls.map((c) => c.id));
			}
		}
		const answered = new Set(
			toolMessages(result.appended).map((m) => m.toolCallId),
		);
		for (const id of calls) {
			expect(answered.has(id)).toBe(true);
		}
	});

	test("mutation cap: the 11th approved mutation is answered synthetically, not executed", async () => {
		const manyCalls = Array.from({ length: 11 }, (_, i) =>
			call(`t${i}`, "create_note", `{"path":"n${i}.md","content":"x"}`),
		);
		const provider = scriptedProvider([
			{ text: "", toolCalls: manyCalls },
			{ text: "done", toolCalls: [] },
		]);
		const executor = recordingExecutor();

		const result = await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "go" }],
			tools: [],
			executor,
			stream: false,
			events: { requestConfirmation: async () => "apply" },
		});

		expect(executor.calls).toHaveLength(10);
		const tools = toolMessages(result.appended);
		expect(tools).toHaveLength(11);
		expect(tools[10]?.content).toContain("Mutation cap");
	});

	test("chatOptions carry maxTokens 4096 and forward sampling overrides", async () => {
		const capturedOpts: ChatOptions[] = [];
		const provider: Provider = {
			name: "capture",
			chat: async () => "unused",
			streamChat: async () => "unused",
			listModels: async () => [],
			chatWithTools: async (_messages, _tools, opts) => {
				capturedOpts.push(opts);
				return { text: "done", toolCalls: [] };
			},
			streamChatWithTools: async (_messages, _tools, opts) => {
				capturedOpts.push(opts);
				return { text: "done", toolCalls: [] };
			},
		};

		await runAgentLoop({
			provider,
			model: "m",
			messages: [{ role: "user", content: "go" }],
			tools: [],
			executor: recordingExecutor(),
			stream: false,
			sampling: { temperature: 0.5, topP: 0.9, seed: 3 },
			events: { requestConfirmation: async () => "apply" },
		});

		expect(capturedOpts[0]).toMatchObject({
			model: "m",
			maxTokens: 4096,
			temperature: 0.5,
			topP: 0.9,
			seed: 3,
		});
	});
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { AnthropicProvider } = await import("../src/providers/anthropic");
const { OpenAICompatibleProvider, ToolCallAssembler, NIM_BASE_URL } =
	await import("../src/providers/openai-compatible");
const { ToolsUnsupportedError, ReasoningOnlyError } = await import(
	"../src/providers/types"
);

import type { AgentMessage, ToolDefinition } from "../src/providers/types";

const TOOLS: ToolDefinition[] = [
	{
		name: "read_note",
		description: "Read a note.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" } },
			required: ["path"],
		},
	},
];

const realFetch = globalThis.fetch;

function setFetch(fn: () => Promise<Response>): void {
	globalThis.fetch = fn as unknown as typeof fetch;
}

beforeEach(() => {
	resetObsidianMock();
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

function sseResponse(events: string[]): Response {
	const encoder = new TextEncoder();
	const stream = new ReadableStream({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${event}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(stream, { status: 200 });
}

describe("byte-identical regression: plain string chats build the exact pre-tools bodies", () => {
	test("anthropic chat()", async () => {
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
		setRequestUrlHandler(() => ({
			json: { content: [{ text: "hi" }] },
		}));

		await provider.chat(
			[
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
			],
			{ model: "claude-sonnet-4-5" },
		);

		expect(requestUrlCalls[0]?.body).toBe(
			JSON.stringify({
				model: "claude-sonnet-4-5",
				max_tokens: 4096,
				system: "sys",
				messages: [{ role: "user", content: "hello" }],
			}),
		);
	});

	test("openai-compatible chat()", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "hi" } }] },
		}));

		await provider.chat(
			[
				{ role: "system", content: "sys" },
				{ role: "user", content: "hello" },
			],
			{ model: "moonshotai/kimi-k2.6", maxTokens: 128 },
		);

		expect(requestUrlCalls[0]?.body).toBe(
			JSON.stringify({
				model: "moonshotai/kimi-k2.6",
				messages: [
					{ role: "system", content: "sys" },
					{ role: "user", content: "hello" },
				],
				max_tokens: 128,
			}),
		);
	});
});

describe("anthropic chatWithTools", () => {
	test("sends tools as input_schema and parses tool_use blocks", async () => {
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
		setRequestUrlHandler(() => ({
			json: {
				content: [
					{ type: "text", text: "Let me read that." },
					{
						type: "tool_use",
						id: "toolu_1",
						name: "read_note",
						input: { path: "A.md" },
					},
				],
			},
		}));

		const turn = await provider.chatWithTools(
			[{ role: "user", content: "read A" }],
			TOOLS,
			{ model: "claude-sonnet-4-5" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.tools).toEqual([
			{
				name: "read_note",
				description: "Read a note.",
				input_schema: TOOLS[0]?.parameters,
			},
		]);
		expect(turn.text).toBe("Let me read that.");
		expect(turn.toolCalls).toEqual([
			{ id: "toolu_1", name: "read_note", arguments: '{"path":"A.md"}' },
		]);
	});

	test("replays assistant tool calls as tool_use and merges tool results into one user message", async () => {
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
		setRequestUrlHandler(() => ({
			json: { content: [{ type: "text", text: "done" }] },
		}));

		const transcript: AgentMessage[] = [
			{ role: "system", content: "sys" },
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: "reading",
				toolCalls: [
					{ id: "t1", name: "read_note", arguments: '{"path":"A.md"}' },
					{ id: "t2", name: "read_note", arguments: '{"path":"B.md"}' },
				],
			},
			{ role: "tool", toolCallId: "t1", content: "aaa" },
			{ role: "tool", toolCallId: "t2", content: "bbb", isError: true },
		];

		await provider.chatWithTools(transcript, TOOLS, {
			model: "claude-sonnet-4-5",
		});

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).toBe("sys");
		expect(body.messages).toEqual([
			{ role: "user", content: "go" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "reading" },
					{
						type: "tool_use",
						id: "t1",
						name: "read_note",
						input: { path: "A.md" },
					},
					{
						type: "tool_use",
						id: "t2",
						name: "read_note",
						input: { path: "B.md" },
					},
				],
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t1", content: "aaa" },
					{
						type: "tool_result",
						tool_use_id: "t2",
						content: "bbb",
						is_error: true,
					},
				],
			},
		]);
	});

	test("streaming assembles input_json_delta fragments into whole tool calls", async () => {
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
		setFetch(async () =>
			sseResponse([
				JSON.stringify({
					type: "content_block_delta",
					delta: { type: "text_delta", text: "On it. " },
				}),
				JSON.stringify({
					type: "content_block_start",
					content_block: { type: "tool_use", id: "toolu_9", name: "read_note" },
				}),
				JSON.stringify({
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: '{"pa' },
				}),
				JSON.stringify({
					type: "content_block_delta",
					delta: { type: "input_json_delta", partial_json: 'th":"A.md"}' },
				}),
				JSON.stringify({ type: "content_block_stop" }),
			]),
		);

		const tokens: string[] = [];
		const turn = await provider.streamChatWithTools(
			[{ role: "user", content: "read A" }],
			TOOLS,
			{ model: "claude-sonnet-4-5" },
			(token) => tokens.push(token),
		);

		expect(tokens.join("")).toBe("On it. ");
		expect(turn.toolCalls).toEqual([
			{ id: "toolu_9", name: "read_note", arguments: '{"path":"A.md"}' },
		]);
	});
});

describe("openai-compatible chatWithTools", () => {
	test("sends function tools and parses tool_calls", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setRequestUrlHandler(() => ({
			json: {
				choices: [
					{
						message: {
							content: null,
							tool_calls: [
								{
									id: "call_1",
									function: {
										name: "read_note",
										arguments: '{"path":"A.md"}',
									},
								},
							],
						},
					},
				],
			},
		}));

		const turn = await provider.chatWithTools(
			[{ role: "user", content: "read A" }],
			TOOLS,
			{ model: "moonshotai/kimi-k2.6" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "read_note",
					description: "Read a note.",
					parameters: TOOLS[0]?.parameters,
				},
			},
		]);
		expect(turn.toolCalls).toEqual([
			{ id: "call_1", name: "read_note", arguments: '{"path":"A.md"}' },
		]);
	});

	test("replays tool results as role:tool messages", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "done" } }] },
		}));

		await provider.chatWithTools(
			[
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call_1", name: "read_note", arguments: '{"path":"A.md"}' },
					],
				},
				{ role: "tool", toolCallId: "call_1", content: "aaa" },
			],
			TOOLS,
			{ model: "moonshotai/kimi-k2.6" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.messages).toEqual([
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{
						id: "call_1",
						type: "function",
						function: { name: "read_note", arguments: '{"path":"A.md"}' },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "aaa" },
		]);
	});

	test("streaming assembles indexed tool_call fragments", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(async () =>
			sseResponse([
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_7",
										function: { name: "read_note", arguments: "" },
									},
								],
							},
						},
					],
				}),
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '{"path":' } }],
							},
						},
					],
				}),
				JSON.stringify({
					choices: [
						{
							delta: {
								tool_calls: [{ index: 0, function: { arguments: '"A.md"}' } }],
							},
						},
					],
				}),
				"[DONE]",
			]),
		);

		const turn = await provider.streamChatWithTools(
			[{ role: "user", content: "read A" }],
			TOOLS,
			{ model: "moonshotai/kimi-k2.6" },
			() => {},
		);

		expect(turn.toolCalls).toEqual([
			{ id: "call_7", name: "read_note", arguments: '{"path":"A.md"}' },
		]);
	});

	test("streaming 400 mentioning tools throws ToolsUnsupportedError (body is read)", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(
			async () =>
				new Response(
					JSON.stringify({
						error: { message: "This model does not support tools." },
					}),
					{ status: 400 },
				),
		);

		await expect(
			provider.streamChatWithTools(
				[{ role: "user", content: "hi" }],
				TOOLS,
				{ model: "google/gemma-3-12b-it" },
				() => {},
			),
		).rejects.toBeInstanceOf(ToolsUnsupportedError);
	});

	test("streaming non-tools failure falls back to non-streaming chatWithTools", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(async () => {
			throw new TypeError("network down");
		});
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "fallback" } }] },
		}));

		const turn = await provider.streamChatWithTools(
			[{ role: "user", content: "hi" }],
			TOOLS,
			{ model: "moonshotai/kimi-k2.6" },
			() => {},
		);

		expect(turn.text).toBe("fallback");
	});
});

describe("reasoning-only streams and NIM DeepSeek quirks", () => {
	test("streamChat: reasoning-only SSE stream throws ReasoningOnlyError, no fallback request", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(async () =>
			sseResponse([
				JSON.stringify({
					choices: [{ delta: { reasoning_content: "thinking..." } }],
				}),
				JSON.stringify({
					choices: [{ delta: { reasoning_content: " more thinking" } }],
				}),
				"[DONE]",
			]),
		);

		await expect(
			provider.streamChat(
				[{ role: "user", content: "hi" }],
				{ model: "deepseek-ai/deepseek-v4-pro" },
				() => {},
			),
		).rejects.toBeInstanceOf(ReasoningOnlyError);
		expect(requestUrlCalls).toHaveLength(0);
	});

	test("streamChat: mixed reasoning_content + content resolves to the content only", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(async () =>
			sseResponse([
				JSON.stringify({
					choices: [{ delta: { reasoning_content: "thinking..." } }],
				}),
				JSON.stringify({ choices: [{ delta: { content: "the answer" } }] }),
				"[DONE]",
			]),
		);

		const tokens: string[] = [];
		const result = await provider.streamChat(
			[{ role: "user", content: "hi" }],
			{ model: "moonshotai/kimi-k2.6" },
			(token) => tokens.push(token),
		);

		expect(result).toBe("the answer");
		expect(tokens.join("")).toBe("the answer");
	});

	test("streamChatWithTools: non-deepseek reasoning-only stream throws ReasoningOnlyError, no fallback request", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setFetch(async () =>
			sseResponse([
				JSON.stringify({
					choices: [{ delta: { reasoning_content: "thinking..." } }],
				}),
				"[DONE]",
			]),
		);

		await expect(
			provider.streamChatWithTools(
				[{ role: "user", content: "hi" }],
				TOOLS,
				{ model: "moonshotai/kimi-k2.6" },
				() => {},
			),
		).rejects.toBeInstanceOf(ReasoningOnlyError);
		expect(requestUrlCalls).toHaveLength(0);
	});

	test("streamChatWithTools: NIM + deepseek-v4 goes through requestUrl (non-streaming), not fetch", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: NIM_BASE_URL,
			apiKey: "nvapi-test",
		});
		let fetchCalled = false;
		setFetch(async () => {
			fetchCalled = true;
			throw new Error("fetch should not be called for NIM deepseek-v4 tools");
		});
		setRequestUrlHandler(() => ({
			json: {
				choices: [
					{
						message: {
							content: "final answer",
							tool_calls: [
								{
									id: "call_1",
									function: {
										name: "read_note",
										arguments: '{"path":"A.md"}',
									},
								},
							],
						},
					},
				],
			},
		}));

		const tokens: string[] = [];
		const turn = await provider.streamChatWithTools(
			[{ role: "user", content: "read A" }],
			TOOLS,
			{ model: "deepseek-ai/deepseek-v4-pro" },
			(token) => tokens.push(token),
		);

		expect(fetchCalled).toBe(false);
		expect(requestUrlCalls).toHaveLength(1);
		expect(requestUrlCalls[0]?.url).toBe(`${NIM_BASE_URL}/chat/completions`);
		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.stream).toBeUndefined();
		expect(body.chat_template_kwargs).toEqual({
			enable_thinking: true,
			thinking: true,
		});
		expect(tokens).toEqual(["final answer"]);
		expect(turn.text).toBe("final answer");
		expect(turn.toolCalls).toEqual([
			{ id: "call_1", name: "read_note", arguments: '{"path":"A.md"}' },
		]);
	});
});

describe("multimodal content serialization", () => {
	test("anthropic image parts become base64 source blocks", async () => {
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });
		setRequestUrlHandler(() => ({
			json: { content: [{ type: "text", text: "a cat" }] },
		}));

		await provider.chatWithTools(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image", mimeType: "image/png", base64: "QUJD" },
					],
				},
			],
			[],
			{ model: "claude-sonnet-4-5" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.messages[0].content).toEqual([
			{ type: "text", text: "what is this?" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "QUJD" },
			},
		]);
	});

	test("openai image parts become data-URI image_url parts", async () => {
		const provider = new OpenAICompatibleProvider({
			baseUrl: "https://integrate.api.nvidia.com/v1",
			apiKey: "nvapi-test",
		});
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "a cat" } }] },
		}));

		await provider.chat(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image", mimeType: "image/png", base64: "QUJD" },
					],
				},
			],
			{ model: "some/vision-model" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.messages[0].content).toEqual([
			{ type: "text", text: "what is this?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
		]);
	});
});

describe("ToolCallAssembler", () => {
	test("orders by index and drops nameless fragments", () => {
		const assembler = new ToolCallAssembler();
		assembler.push({ index: 1, function: { name: "b_tool", arguments: "{}" } });
		assembler.push({ index: 0, id: "call_a", function: { name: "a_tool" } });
		assembler.push({ index: 0, function: { arguments: '{"x":1}' } });
		assembler.push({ index: 2, function: { arguments: "{}" } });

		expect(assembler.finish()).toEqual([
			{ id: "call_a", name: "a_tool", arguments: '{"x":1}' },
			{ id: "call_1", name: "b_tool", arguments: "{}" },
		]);
	});
});

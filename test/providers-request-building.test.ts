import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { AnthropicProvider } = await import("../src/providers/anthropic");
const { OpenAICompatibleProvider, NIM_BASE_URL } = await import(
	"../src/providers/openai-compatible"
);

beforeEach(() => {
	resetObsidianMock();
});

describe("AnthropicProvider.chat request building", () => {
	test("posts to the Messages API with the correct headers", async () => {
		setRequestUrlHandler(() => ({ json: { content: [{ text: "hello" }] } }));
		const provider = new AnthropicProvider({ apiKey: "sk-ant-test" });

		await provider.chat([{ role: "user", content: "hi" }], {
			model: "claude-sonnet-4-5",
		});

		expect(requestUrlCalls).toHaveLength(1);
		const call = requestUrlCalls[0];
		expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
		expect(call?.method).toBe("POST");
		expect(call?.headers?.["x-api-key"]).toBe("sk-ant-test");
		expect(call?.headers?.["anthropic-version"]).toBe("2023-06-01");
		expect(call?.headers?.["content-type"]).toBe("application/json");
	});

	test("lifts the system message to a top-level `system` field", async () => {
		setRequestUrlHandler(() => ({ json: { content: [{ text: "hello" }] } }));
		const provider = new AnthropicProvider({ apiKey: "key" });

		await provider.chat(
			[
				{ role: "system", content: "You are Flint." },
				{ role: "user", content: "hi" },
			],
			{ model: "claude-sonnet-4-5" },
		);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).toBe("You are Flint.");
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(
			body.messages.some((m: { role: string }) => m.role === "system"),
		).toBe(false);
	});

	test("returns the assembled answer text", async () => {
		setRequestUrlHandler(() => ({
			json: { content: [{ text: "the answer" }] },
		}));
		const provider = new AnthropicProvider({ apiKey: "key" });

		const result = await provider.chat([{ role: "user", content: "hi" }], {
			model: "claude-sonnet-4-5",
		});

		expect(result).toBe("the answer");
	});
});

describe("OpenAICompatibleProvider.chat request building", () => {
	test("posts to <baseUrl>/chat/completions with a bearer token", async () => {
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "hi there" } }] },
		}));
		const provider = new OpenAICompatibleProvider({
			baseUrl: NIM_BASE_URL,
			apiKey: "nvapi-test",
		});

		const result = await provider.chat([{ role: "user", content: "hi" }], {
			model: "meta/llama-3.1-8b-instruct",
		});

		expect(requestUrlCalls).toHaveLength(1);
		const call = requestUrlCalls[0];
		expect(call?.url).toBe(`${NIM_BASE_URL}/chat/completions`);
		expect(call?.method).toBe("POST");
		expect(call?.headers?.Authorization).toBe("Bearer nvapi-test");
		expect(call?.headers?.["Content-Type"]).toBe("application/json");

		const body = JSON.parse(call?.body ?? "{}");
		expect(body.model).toBe("meta/llama-3.1-8b-instruct");
		expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
		expect(result).toBe("hi there");
	});

	test("works against an arbitrary OpenAI-compatible base URL (e.g. Ollama)", async () => {
		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "ok" } }] },
		}));
		const provider = new OpenAICompatibleProvider({
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
		});

		await provider.chat([{ role: "user", content: "hi" }], { model: "llama3" });

		expect(requestUrlCalls[0]?.url).toBe(
			"http://localhost:11434/v1/chat/completions",
		);
	});
});

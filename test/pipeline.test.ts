import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import { createFakeApp } from "./fake-vault";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { buildSystemPrompt, runPipeline } = await import("../src/chat/pipeline");
const { VaultIndex } = await import("../src/index/vault-index");
const { DEFAULT_SETTINGS } = await import("../src/settings");
const { NIM_BASE_URL } = await import("../src/providers/openai-compatible");

beforeEach(() => {
	resetObsidianMock();
});

function cloneSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

describe("buildSystemPrompt", () => {
	test("cites retrieved chunk paths and includes their text", () => {
		const prompt = buildSystemPrompt([
			{
				id: "a#0",
				path: "01 Projects/rocket.md",
				heading: "Fuel",
				text: "Liquid fuel is dense.",
			},
		]);

		expect(prompt).toContain("01 Projects/rocket.md");
		expect(prompt).toContain("Fuel");
		expect(prompt).toContain("Liquid fuel is dense.");
	});

	test("says plainly when no notes were found", () => {
		const prompt = buildSystemPrompt([]);
		expect(prompt).toContain("No relevant notes were found");
	});
});

describe("runPipeline", () => {
	test("retrieves vault chunks, cites their paths, and calls the configured provider", async () => {
		const app = createFakeApp([
			{
				path: "01 Projects/rocket.md",
				content:
					"# Rocket engine\nDesigning a liquid-fuel rocket engine for the Mars mission.",
			},
			{
				path: "01 Projects/garden.md",
				content: "# Garden\nTomato planting schedule for spring.",
			},
		]);
		const index = new VaultIndex(app, []);
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "Here is the answer." }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.activeModel = "claude-sonnet-4-5";

		const result = await runPipeline("rocket engine fuel", settings, index);

		expect(result.answer).toBe("Here is the answer.");
		expect(result.citations).toEqual(["01 Projects/rocket.md"]);

		// Hit the Anthropic endpoint (provider selection from settings).
		expect(requestUrlCalls[0]?.url).toBe(
			"https://api.anthropic.com/v1/messages",
		);

		// The system prompt sent to the provider carries the retrieved excerpt.
		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).toContain("01 Projects/rocket.md");
		expect(body.system).toContain("liquid-fuel rocket engine");
		expect(body.messages).toEqual([
			{ role: "user", content: "rocket engine fuel" },
		]);
	});

	test("selects the NIM OpenAI-compatible provider when configured", async () => {
		const app = createFakeApp([]);
		const index = new VaultIndex(app, []);
		await index.build();

		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "nim answer" } }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "nim";
		settings.providers.nim.apiKey = "nvapi-test";
		settings.activeModel = "meta/llama-3.1-8b-instruct";

		const result = await runPipeline("anything", settings, index);

		expect(result.answer).toBe("nim answer");
		expect(result.citations).toEqual([]);
		expect(requestUrlCalls[0]?.url).toBe(`${NIM_BASE_URL}/chat/completions`);
		expect(requestUrlCalls[0]?.headers?.Authorization).toBe(
			"Bearer nvapi-test",
		);
	});

	test("includes prior conversation history between the system prompt and the new query", async () => {
		const app = createFakeApp([]);
		const index = new VaultIndex(app, []);
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "ok" }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "key";

		await runPipeline("follow-up question", settings, index, {
			history: [
				{ role: "user", content: "first question" },
				{ role: "assistant", content: "first answer" },
			],
		});

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.messages).toEqual([
			{ role: "user", content: "first question" },
			{ role: "assistant", content: "first answer" },
			{ role: "user", content: "follow-up question" },
		]);
	});
});

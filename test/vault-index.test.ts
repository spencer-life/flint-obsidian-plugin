import { describe, expect, test } from "bun:test";
import { chunkNote } from "../src/index/chunk";
import { VaultIndex } from "../src/index/vault-index";
import { createFakeApp } from "./fake-vault";

describe("chunkNote", () => {
	test("splits a note into per-heading chunks", () => {
		const content = [
			"# Intro",
			"Some intro text.",
			"## Details",
			"More detail text.",
			"## Conclusion",
			"Wrapping up.",
		].join("\n");

		const chunks = chunkNote("notes/example.md", content);

		expect(chunks.map((c) => c.heading)).toEqual([
			"Intro",
			"Details",
			"Conclusion",
		]);
		expect(chunks.every((c) => c.path === "notes/example.md")).toBe(true);
		expect(chunks[0]?.text).toBe("Some intro text.");
	});

	test("splits an overlong section into ~600-word windows", () => {
		const longBody = Array.from({ length: 1300 }, (_, i) => `word${i}`).join(
			" ",
		);
		const content = `# Long section\n${longBody}`;

		const chunks = chunkNote("notes/long.md", content);

		// 1300 words / 600-word windows -> 3 chunks (600, 600, 100)
		expect(chunks).toHaveLength(3);
		expect(chunks.every((c) => c.heading === "Long section")).toBe(true);
		expect(chunks[2]?.text.split(/\s+/)).toHaveLength(100);
		// ids stay unique across the split chunks of the same section
		expect(new Set(chunks.map((c) => c.id)).size).toBe(3);
	});

	test("a note with no headings becomes a single implicit section", () => {
		const chunks = chunkNote("notes/flat.md", "Just plain text, no headings.");
		expect(chunks).toHaveLength(1);
		expect(chunks[0]?.heading).toBe("");
	});
});

describe("VaultIndex", () => {
	test("build() excludes configured folders from both indexing and retrieval", async () => {
		const app = createFakeApp([
			{
				path: "01 Projects/rocket.md",
				content: "# Rocket engine\nDesigning a liquid-fuel rocket engine.",
			},
			{
				path: "04 Dev Docs/rocket-internal.md",
				content:
					"# Rocket internals\nInternal dev notes about the rocket engine build.",
			},
		]);

		const index = new VaultIndex(app, ["04 Dev Docs"]);
		await index.build();

		const results = index.retrieve("rocket engine");
		expect(
			results.some((r) => r.path === "04 Dev Docs/rocket-internal.md"),
		).toBe(false);
		expect(results.some((r) => r.path === "01 Projects/rocket.md")).toBe(true);
	});

	test("retrieve() ranks the most relevant chunk first and respects top-k", async () => {
		const app = createFakeApp([
			{
				path: "notes/cooking.md",
				content: "# Cooking\nHow to bake sourdough bread at home.",
			},
			{
				path: "notes/gardening.md",
				content: "# Gardening\nHow to grow tomatoes in a backyard garden.",
			},
			{
				path: "notes/baking-extra.md",
				content: "# Baking\nSourdough starter feeding schedule and bread tips.",
			},
		]);

		const index = new VaultIndex(app, []);
		await index.build();

		const results = index.retrieve("sourdough bread", 1);
		expect(results).toHaveLength(1);
		const topPath = results[0]?.path ?? "";
		expect(["notes/cooking.md", "notes/baking-extra.md"]).toContain(topPath);
		expect(topPath).not.toBe("notes/gardening.md");
	});

	test("indexFile / removePath incrementally update the index", async () => {
		const app = createFakeApp([
			{ path: "notes/a.md", content: "# A\nAlpha content about widgets." },
		]);
		const index = new VaultIndex(app, []);
		await index.build();

		expect(index.retrieve("widgets")).toHaveLength(1);

		index.removePath("notes/a.md");
		expect(index.retrieve("widgets")).toHaveLength(0);
	});

	test("setExcludeFolders + removePath reflect a folder becoming excluded", async () => {
		const app = createFakeApp([
			{ path: "04 Dev Docs/secret.md", content: "# Secret\nInternal only." },
		]);
		const index = new VaultIndex(app, []);
		await index.build();
		expect(index.retrieve("internal")).toHaveLength(1);

		index.setExcludeFolders(["04 Dev Docs"]);
		await index.build();
		expect(index.retrieve("internal")).toHaveLength(0);
	});
});

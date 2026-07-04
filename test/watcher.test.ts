import { afterEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import type FlintPlugin from "../src/main";
import { createFakeClipPlugin } from "./fake-clip-app";

const { ClipWatcher } = await import("../src/ingest/watcher");

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ClipWatcher.scanBacklog", () => {
	test("processes only unprocessed clips inside the clippings folder", async () => {
		const { plugin, getFile } = createFakeClipPlugin(
			[
				{ path: "03 Clippings/new-clip.md", content: "# New Clip\nBody." },
				{
					path: "03 Clippings/already-done.md",
					content: "# Done\nBody.",
					frontmatter: {
						flint: "processed",
						clipped: "2020-01-01T00:00:00.000Z",
					},
				},
				{ path: "01 Projects/unrelated.md", content: "# Unrelated\nBody." },
			],
			{ clippingsFolder: "03 Clippings" },
		);

		const watcher = new ClipWatcher(plugin as unknown as FlintPlugin);
		await watcher.scanBacklog();

		expect(getFile("03 Clippings/new-clip.md")?.frontmatter?.flint).toBe(
			"processed",
		);
		expect(getFile("03 Clippings/already-done.md")?.frontmatter?.clipped).toBe(
			"2020-01-01T00:00:00.000Z",
		); // untouched, not reprocessed
		expect(getFile("01 Projects/unrelated.md")?.frontmatter).toBeUndefined();
	});

	test("stamps a source URL discovered in existing frontmatter", async () => {
		const { plugin, getFile } = createFakeClipPlugin(
			[
				{
					path: "03 Clippings/clip.md",
					content: "# Clip\nBody.",
					frontmatter: { source: "https://example.com/post" },
				},
			],
			{ clippingsFolder: "03 Clippings" },
		);

		const watcher = new ClipWatcher(plugin as unknown as FlintPlugin);
		await watcher.scanBacklog();

		const file = getFile("03 Clippings/clip.md");
		expect(file?.frontmatter?.source).toBe("https://example.com/post");
		expect(file?.frontmatter?.flint).toBe("processed");
		expect(typeof file?.frontmatter?.clipped).toBe("string");
	});

	test("normalizes an egregious filename using the note's first heading", async () => {
		const { plugin, getFile } = createFakeClipPlugin(
			[
				{
					path: "03 Clippings/Untitled.md",
					content: "# A Great Article\nBody.",
				},
			],
			{ clippingsFolder: "03 Clippings" },
		);

		const watcher = new ClipWatcher(plugin as unknown as FlintPlugin);
		await watcher.scanBacklog();

		expect(getFile("03 Clippings/Untitled.md")).toBeUndefined();
		expect(getFile("03 Clippings/A Great Article.md")).toBeDefined();
	});
});

describe("ClipWatcher.register (debounce + idempotency)", () => {
	test("debounces a burst of create events into a single processing pass", async () => {
		const { plugin, getFile, emitCreate } = createFakeClipPlugin(
			[
				{ path: "03 Clippings/a.md", content: "# A\nBody." },
				{ path: "03 Clippings/b.md", content: "# B\nBody." },
			],
			{ clippingsFolder: "03 Clippings" },
		);

		const watcher = new ClipWatcher(plugin as unknown as FlintPlugin);
		watcher.register();

		emitCreate("03 Clippings/a.md");
		emitCreate("03 Clippings/b.md");

		// Not yet processed — debounce hasn't fired.
		expect(getFile("03 Clippings/a.md")?.frontmatter).toBeUndefined();

		await wait(1400);

		expect(getFile("03 Clippings/a.md")?.frontmatter?.flint).toBe("processed");
		expect(getFile("03 Clippings/b.md")?.frontmatter?.flint).toBe("processed");
	});

	test("a rename does not reprocess an already-processed clip", async () => {
		const { plugin, app, getFile } = createFakeClipPlugin(
			[
				{
					path: "03 Clippings/clip.md",
					content: "# Clip\nBody.",
					frontmatter: {
						flint: "processed",
						clipped: "2020-01-01T00:00:00.000Z",
					},
				},
			],
			{ clippingsFolder: "03 Clippings" },
		);

		const watcher = new ClipWatcher(plugin as unknown as FlintPlugin);
		watcher.register();

		const file = app.vault.getAbstractFileByPath("03 Clippings/clip.md");
		if (!file) throw new Error("expected fake file to exist");
		await app.fileManager.renameFile(file, "03 Clippings/renamed-clip.md");

		await wait(1400);

		expect(getFile("03 Clippings/renamed-clip.md")?.frontmatter?.clipped).toBe(
			"2020-01-01T00:00:00.000Z",
		);
	});
});

afterEach(() => {
	// no shared state to reset between tests in this file
});

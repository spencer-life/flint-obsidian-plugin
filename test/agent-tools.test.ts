import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import type { App } from "obsidian";
import type { VaultIndex } from "../src/index/vault-index";
import { createFakeApp } from "./fake-vault";
import { resetObsidianMock } from "./obsidian-mock";

const { VaultToolExecutor } = await import("../src/agent/vault-tools");
const { parseToolArguments, isMutatingTool, TOOL_DEFINITIONS } = await import(
	"../src/agent/tool-schemas"
);
const { DEFAULT_SETTINGS } = await import("../src/settings");

beforeEach(() => {
	resetObsidianMock();
});

function makeExecutor(app: App, retrieve?: VaultIndex["retrieve"]) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.captureFolder = "00 Start/Inbox";
	settings.excludeFolders = ["04 Dev Docs"];
	settings.organizeExcludeFolders = ["02 Claude"];
	const index = {
		retrieve: retrieve ?? (async () => []),
	} as unknown as VaultIndex;
	return new VaultToolExecutor(app, settings, index);
}

const FOLDERS = [
	"00 Start/Inbox",
	"01 Projects",
	"01 Projects/Site",
	"02 Claude/Deliverables",
	"04 Dev Docs",
];

describe("tool schema plumbing", () => {
	test("mutating/read-only split matches the definitions", () => {
		expect(isMutatingTool("move_note")).toBe(true);
		expect(isMutatingTool("create_note")).toBe(true);
		expect(isMutatingTool("search_vault")).toBe(false);
		expect(isMutatingTool("read_note")).toBe(false);
		const names = TOOL_DEFINITIONS.map((tool) => tool.name);
		expect(names).toContain("search_vault");
		expect(names).not.toContain("delete_note");
	});

	test("parseToolArguments: empty → {}, garbage → throws, non-object → throws", () => {
		expect(parseToolArguments("")).toEqual({});
		expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 });
		expect(() => parseToolArguments("{oops")).toThrow();
		expect(() => parseToolArguments("[1,2]")).toThrow();
	});
});

describe("path validation", () => {
	test("rejects traversal and absolute paths as error results", async () => {
		const app = createFakeApp([{ path: "A.md", content: "x" }], {
			folders: FOLDERS,
		});
		const executor = makeExecutor(app);

		for (const path of ["../secrets.md", "a/../../b.md", "/etc/passwd"]) {
			const result = await executor.execute("read_note", { path });
			expect(result.isError).toBe(true);
		}
	});

	test("missing note yields a guiding error, not a throw", async () => {
		const app = createFakeApp([], { folders: FOLDERS });
		const executor = makeExecutor(app);
		const result = await executor.execute("read_note", { path: "Nope.md" });
		expect(result.isError).toBe(true);
		expect(result.content).toContain("search_vault");
	});
});

describe("read_note / search_vault", () => {
	test("reads content and truncates huge notes", async () => {
		const app = createFakeApp(
			[
				{ path: "Small.md", content: "hello" },
				{ path: "Big.md", content: "y".repeat(10000) },
			],
			{ folders: FOLDERS },
		);
		const executor = makeExecutor(app);

		const small = await executor.execute("read_note", { path: "Small.md" });
		expect(small).toEqual({ content: "hello", isError: false });

		const big = await executor.execute("read_note", { path: "Big.md" });
		expect(big.content).toContain("[truncated]");
		expect(big.content.length).toBeLessThan(7000);
	});

	test("search returns paths with snippets", async () => {
		const app = createFakeApp([], { folders: FOLDERS });
		const executor = makeExecutor(
			app,
			async () =>
				[
					{
						path: "01 Projects/Site/Plan.md",
						text: "the plan",
						heading: "Goals",
					},
				] as never,
		);
		const result = await executor.execute("search_vault", { query: "plan" });
		expect(result.isError).toBe(false);
		expect(result.content).toContain("01 Projects/Site/Plan.md — Goals");
		expect(result.content).toContain("the plan");
	});
});

describe("create_note", () => {
	test("creates (with parent folders) and refuses to overwrite", async () => {
		const app = createFakeApp([{ path: "Exists.md", content: "x" }], {
			folders: FOLDERS,
		});
		const executor = makeExecutor(app);

		const created = await executor.execute("create_note", {
			path: "01 Projects/New Area/Idea",
			content: "body",
		});
		expect(created.isError).toBe(false);
		const file = app.vault.getAbstractFileByPath(
			"01 Projects/New Area/Idea.md",
		);
		expect(file).not.toBeNull();

		const clobber = await executor.execute("create_note", {
			path: "Exists.md",
			content: "nope",
		});
		expect(clobber.isError).toBe(true);
		expect(clobber.content).toContain("already exists");
	});
});

describe("edit_note uniqueness", () => {
	test("replaces a unique occurrence; errors on missing and ambiguous", async () => {
		const app = createFakeApp(
			[{ path: "Note.md", content: "alpha beta alpha" }],
			{ folders: FOLDERS },
		);
		const executor = makeExecutor(app);

		const missing = await executor.execute("edit_note", {
			path: "Note.md",
			old_text: "gamma",
			new_text: "x",
		});
		expect(missing.isError).toBe(true);
		expect(missing.content).toContain("not found");

		const ambiguous = await executor.execute("edit_note", {
			path: "Note.md",
			old_text: "alpha",
			new_text: "x",
		});
		expect(ambiguous.isError).toBe(true);
		expect(ambiguous.content).toContain("more than once");

		const ok = await executor.execute("edit_note", {
			path: "Note.md",
			old_text: "beta",
			new_text: "BETA",
		});
		expect(ok.isError).toBe(false);
		const file = app.vault.getFileByPath("Note.md");
		expect(file && (await app.vault.read(file))).toBe("alpha BETA alpha");
	});
});

describe("move_note allowlist", () => {
	test("moves into an allowlisted folder and logs to Flint Log", async () => {
		const app = createFakeApp(
			[{ path: "00 Start/Inbox/Clip.md", content: "clip" }],
			{ folders: FOLDERS },
		);
		const executor = makeExecutor(app);

		const result = await executor.execute("move_note", {
			path: "00 Start/Inbox/Clip.md",
			destination: "01 Projects/Site",
		});
		expect(result.isError).toBe(false);
		expect(app.vault.getFileByPath("01 Projects/Site/Clip.md")).not.toBeNull();

		const log = app.vault.getFileByPath("Flint Log.md");
		expect(log).not.toBeNull();
		if (log) {
			const text = await app.vault.read(log);
			expect(text).toContain("chat: moved");
			expect(text).toContain("[[01 Projects/Site/Clip]]");
		}
	});

	test("rejects excluded, capture, and fabricated destinations", async () => {
		const app = createFakeApp(
			[{ path: "00 Start/Inbox/Clip.md", content: "clip" }],
			{ folders: FOLDERS },
		);
		const executor = makeExecutor(app);

		for (const destination of [
			"02 Claude/Deliverables", // organize-excluded
			"04 Dev Docs", // retrieval-excluded
			"00 Start/Inbox", // capture folder
			"01 Projects/Imaginary", // doesn't exist
		]) {
			const result = await executor.execute("move_note", {
				path: "00 Start/Inbox/Clip.md",
				destination,
			});
			expect(result.isError).toBe(true);
			expect(result.content).toContain("not an allowed destination");
		}
		// Nothing moved.
		expect(app.vault.getFileByPath("00 Start/Inbox/Clip.md")).not.toBeNull();
	});
});

describe("add_tags", () => {
	test("merges sanitized tags into frontmatter without duplicates", async () => {
		const app = createFakeApp(
			[
				{
					path: "Note.md",
					content: "x",
					frontmatter: { tags: ["existing"] },
				},
			],
			{ folders: FOLDERS },
		);
		const executor = makeExecutor(app);

		const result = await executor.execute("add_tags", {
			path: "Note.md",
			tags: ["New!", "existing", "web-dev"],
		});
		expect(result.isError).toBe(false);

		const file = app.vault.getFileByPath("Note.md");
		const cache = file ? app.metadataCache.getFileCache(file) : null;
		expect(cache?.frontmatter?.["tags"]).toEqual([
			"existing",
			"new",
			"web-dev",
		]);
	});
});

import { describe, expect, test } from "bun:test";
import "./obsidian-mock";
import { createFakeApp } from "./fake-vault";

const { computeDestinationAllowlist, renderFolderTree } = await import(
	"../src/agent/vault-tree"
);

function appWithFolders(folders: string[]) {
	return createFakeApp([], { folders });
}

describe("computeDestinationAllowlist", () => {
	const FOLDERS = [
		"00 Start/Inbox",
		"01 Projects/Website Relaunch",
		"02 Claude/Deliverables",
		"02 Claude/Config",
		"03 Clippings/Archive",
		"06 Templates",
	];

	test("excludes the capture folder AND its subfolders", () => {
		const app = appWithFolders(FOLDERS);
		const allowlist = computeDestinationAllowlist(app.vault.getRoot(), {
			excludedFolders: [],
			captureFolder: "03 Clippings",
		});
		expect(allowlist).not.toContain("03 Clippings");
		expect(allowlist).not.toContain("03 Clippings/Archive");
		expect(allowlist).toContain("01 Projects/Website Relaunch");
	});

	test("excludes every excluded folder and its subfolders", () => {
		const app = appWithFolders(FOLDERS);
		const allowlist = computeDestinationAllowlist(app.vault.getRoot(), {
			excludedFolders: ["02 Claude", "06 Templates"],
			captureFolder: "03 Clippings",
		});
		expect(allowlist).not.toContain("02 Claude");
		expect(allowlist).not.toContain("02 Claude/Deliverables");
		expect(allowlist).not.toContain("02 Claude/Config");
		expect(allowlist).not.toContain("06 Templates");
		expect(allowlist).toContain("00 Start");
		expect(allowlist).toContain("00 Start/Inbox");
	});

	test("does not exclude look-alike prefixes without a path separator", () => {
		const app = appWithFolders(["02 Claude", "02 Claude Extra"]);
		const allowlist = computeDestinationAllowlist(app.vault.getRoot(), {
			excludedFolders: ["02 Claude"],
			captureFolder: "zz-none",
		});
		expect(allowlist).not.toContain("02 Claude");
		expect(allowlist).toContain("02 Claude Extra");
	});

	test("returns a sorted list", () => {
		const app = appWithFolders(["B Folder", "A Folder"]);
		const allowlist = computeDestinationAllowlist(app.vault.getRoot(), {
			excludedFolders: [],
			captureFolder: "zz-none",
		});
		expect(allowlist).toEqual(["A Folder", "B Folder"]);
	});
});

describe("renderFolderTree", () => {
	test("renders an indented, depth-capped tree of folder names", () => {
		const app = appWithFolders([
			"01 Projects/Website/Design/Drafts",
			"03 Clippings",
		]);
		const tree = renderFolderTree(app.vault.getRoot(), {
			maxDepth: 2,
			maxEntries: 150,
		});
		expect(tree).toContain("01 Projects/");
		expect(tree).toContain("  Website/");
		// Depth 2 cuts off Design/ and below.
		expect(tree).not.toContain("Design/");
	});

	test("caps entries and marks truncation", () => {
		const many = Array.from({ length: 20 }, (_, i) => `Folder ${i}`);
		const app = appWithFolders(many);
		const tree = renderFolderTree(app.vault.getRoot(), {
			maxDepth: 4,
			maxEntries: 5,
		});
		expect(tree.split("\n").length).toBe(6);
		expect(tree).toContain("(tree truncated)");
	});
});

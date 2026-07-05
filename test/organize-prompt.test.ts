import { describe, expect, test } from "bun:test";
import { buildOrganizePrompt } from "../src/triage/organize-prompt";

describe("buildOrganizePrompt", () => {
	test("includes the capture content and every allowlisted folder", () => {
		const messages = buildOrganizePrompt(
			"buy a domain for the new site",
			["01 Projects/Website Relaunch", "00 Start/Ideas"],
			[],
		);

		const user = messages.find((m) => m.role === "user");
		expect(user).toBeDefined();
		expect(user?.content).toContain("buy a domain for the new site");
		expect(user?.content).toContain("01 Projects/Website Relaunch");
		expect(user?.content).toContain("00 Start/Ideas");
	});

	test("includes a system message instructing strict JSON output", () => {
		const messages = buildOrganizePrompt("some capture", [], []);
		const system = messages.find((m) => m.role === "system");
		expect(system?.content).toContain("JSON");
	});

	test("notes when there are no destination folders available", () => {
		const messages = buildOrganizePrompt("some capture", [], []);
		const user = messages.find((m) => m.role === "user");
		expect(user?.content).toContain("no destination folders available");
	});

	test("includes similar notes as routing evidence when provided", () => {
		const messages = buildOrganizePrompt(
			"some capture",
			["01 Projects/Site"],
			[
				{ path: "01 Projects/Site/notes.md" },
				{ path: "01 Projects/Site/plan.md" },
			],
		);

		const user = messages.find((m) => m.role === "user");
		expect(user?.content).toContain("Similar existing notes");
		expect(user?.content).toContain("01 Projects/Site/notes.md");
		expect(user?.content).toContain("01 Projects/Site/plan.md");
	});

	test("degrades to folder-list-only when no similar notes are given", () => {
		const messages = buildOrganizePrompt("some capture", ["01 Projects/Site"]);
		const user = messages.find((m) => m.role === "user");
		expect(user?.content).not.toContain("Similar existing notes");
	});
});

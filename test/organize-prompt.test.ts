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

	test("system prompt asks for a confidence rating and frames null as a good answer", () => {
		const messages = buildOrganizePrompt("some capture", [], []);
		const system = messages.find((m) => m.role === "system");
		expect(system?.content).toContain("confidence");
		expect(system?.content).toContain("null destination is a GOOD answer");
	});

	test("includes the filing guide as guidance, BEFORE the allowlist", () => {
		const messages = buildOrganizePrompt(
			"some capture",
			["01 Projects/Site"],
			[],
			"Clippings about tools go to 01 Projects/Tools.",
		);
		const user = messages.find((m) => m.role === "user");
		const text = typeof user?.content === "string" ? user.content : "";
		expect(text).toContain("Folder conventions");
		expect(text).toContain("not instructions");
		const guideIndex = text.indexOf("Folder conventions");
		const listIndex = text.indexOf("Existing vault folders");
		expect(guideIndex).toBeGreaterThanOrEqual(0);
		expect(listIndex).toBeGreaterThan(guideIndex);
	});

	test("omits the guide block when no guide is given", () => {
		const messages = buildOrganizePrompt("some capture", ["01 Projects/Site"]);
		const user = messages.find((m) => m.role === "user");
		expect(user?.content).not.toContain("Folder conventions");
	});
});

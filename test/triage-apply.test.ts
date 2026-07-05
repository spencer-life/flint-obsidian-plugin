import { describe, expect, test } from "bun:test";
import {
	appendUnderHeading,
	NEXT_STEPS_HEADING,
	removeBullets,
} from "../src/triage/apply";

describe("appendUnderHeading", () => {
	test("appends under the plain heading (the vault trackers' real heading) mid-file", () => {
		const content = [
			"# Project",
			"",
			"## Next small steps",
			"- [ ] existing task",
			"",
			"## Notes",
			"Some notes here.",
		].join("\n");

		const result = appendUnderHeading(content, NEXT_STEPS_HEADING, [
			"- [ ] new task (from: capture)",
		]);

		const lines = result.split("\n");
		const headingIdx = lines.indexOf("## Next small steps");
		const notesIdx = lines.indexOf("## Notes");

		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(notesIdx).toBeGreaterThan(headingIdx);
		expect(result).toContain("- [ ] existing task");
		expect(result).toContain("- [ ] new task (from: capture)");

		// New task appears after the existing one, still before "## Notes".
		const existingIdx = lines.indexOf("- [ ] existing task");
		const newIdx = lines.indexOf("- [ ] new task (from: capture)");
		expect(newIdx).toBeGreaterThan(existingIdx);
		expect(newIdx).toBeLessThan(notesIdx);

		// The Notes section content is preserved untouched.
		expect(result).toContain("Some notes here.");

		// No duplicate heading was created.
		expect(result.match(/^#{1,6}.*next small steps/gim)?.length).toBe(1);
	});

	test("still matches the emoji-prefixed variant when that's the one already in the file", () => {
		const content = [
			"# Project",
			"",
			"## 👉 Next small steps",
			"- [ ] existing task",
			"",
			"## Notes",
			"Some notes here.",
		].join("\n");

		const result = appendUnderHeading(content, NEXT_STEPS_HEADING, [
			"- [ ] new task (from: capture)",
		]);

		const lines = result.split("\n");
		const headingIdx = lines.indexOf("## 👉 Next small steps");
		const notesIdx = lines.indexOf("## Notes");

		expect(headingIdx).toBeGreaterThanOrEqual(0);
		expect(notesIdx).toBeGreaterThan(headingIdx);
		expect(result).toContain("- [ ] existing task");
		expect(result).toContain("- [ ] new task (from: capture)");
		// The existing emoji heading is reused, not duplicated as a plain one.
		expect(result.match(/^#{1,6}.*next small steps/gim)?.length).toBe(1);
	});

	test("matches even when the caller passes the emoji heading and the file has the plain one", () => {
		const content = [
			"# Project",
			"",
			"## Next small steps",
			"- [ ] existing task",
		].join("\n");

		const result = appendUnderHeading(content, "## 👉 Next small steps", [
			"- [ ] new task",
		]);

		expect(result).toContain("- [ ] existing task\n- [ ] new task");
		expect(result.match(/^#{1,6}.*next small steps/gim)?.length).toBe(1);
	});

	test("appends to the heading's section when it's the last section (EOF)", () => {
		const content = [
			"# Project",
			"",
			NEXT_STEPS_HEADING,
			"- [ ] existing",
		].join("\n");

		const result = appendUnderHeading(content, NEXT_STEPS_HEADING, [
			"- [ ] new one",
		]);

		expect(result).toContain("- [ ] existing\n- [ ] new one");
	});

	test("creates the plain heading at EOF when it's missing", () => {
		const content = "# Project\n\nSome existing body text.";

		const result = appendUnderHeading(content, NEXT_STEPS_HEADING, [
			"- [ ] first task",
		]);

		expect(result).toContain("Some existing body text.");
		const headingIdx = result.indexOf(NEXT_STEPS_HEADING);
		const taskIdx = result.indexOf("- [ ] first task");
		expect(headingIdx).toBeGreaterThan(-1);
		expect(taskIdx).toBeGreaterThan(headingIdx);
	});

	test("creates the heading in an empty note", () => {
		const result = appendUnderHeading("", NEXT_STEPS_HEADING, ["- [ ] a task"]);
		expect(result).toBe(`${NEXT_STEPS_HEADING}\n- [ ] a task\n`);
	});

	test("is a no-op when there are no lines to append", () => {
		const content = "# Project\nBody.";
		expect(appendUnderHeading(content, NEXT_STEPS_HEADING, [])).toBe(content);
	});
});

describe("removeBullets", () => {
	test("removes only the matching raw lines, preserving everything else", () => {
		const content = [
			"# Inbox",
			"- 2026-07-04 14:22 — buy a domain",
			"- 2026-07-04 09:00 — call the dentist",
			"- 2026-07-04 10:00 — unrelated item",
		].join("\n");

		const result = removeBullets(content, [
			"- 2026-07-04 14:22 — buy a domain",
			"- 2026-07-04 09:00 — call the dentist",
		]);

		expect(result).not.toContain("buy a domain");
		expect(result).not.toContain("call the dentist");
		expect(result).toContain("# Inbox");
		expect(result).toContain("- 2026-07-04 10:00 — unrelated item");
	});

	test("is a no-op when there is nothing to remove", () => {
		const content = "# Inbox\n- an item";
		expect(removeBullets(content, [])).toBe(content);
	});

	test("preserves CRLF line endings when present", () => {
		const content = "# Inbox\r\n- keep me\r\n- remove me\r\n";
		const result = removeBullets(content, ["- remove me"]);
		expect(result).toBe("# Inbox\r\n- keep me\r\n");
	});
});

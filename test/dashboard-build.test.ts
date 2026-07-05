import { describe, expect, test } from "bun:test";
import {
	buildDailyNote,
	type DashboardFile,
	extractNextSteps,
	filterRecentFiles,
	localDateString,
} from "../src/dashboard/build";

describe("extractNextSteps", () => {
	test("extracts unchecked items under the plain heading, capped at 3", () => {
		const content = [
			"# Project",
			"",
			"## Next small steps",
			"- [ ] first step",
			"- [x] already done",
			"- [ ] second step",
			"- [ ] third step",
			"- [ ] fourth step (should be dropped, cap is 3)",
			"",
			"## Notes",
			"Some notes here.",
		].join("\n");

		const steps = extractNextSteps(content);

		expect(steps).toEqual(["first step", "second step", "third step"]);
	});

	test("matches the emoji-prefixed heading variant", () => {
		const content = [
			"# Project",
			"",
			"## 👉 Next small steps",
			"- [ ] emoji-heading step",
			"",
			"## Notes",
		].join("\n");

		expect(extractNextSteps(content)).toEqual(["emoji-heading step"]);
	});

	test("returns an empty array when the heading is missing", () => {
		const content = "# Project\n\nNo next-steps heading here.";
		expect(extractNextSteps(content)).toEqual([]);
	});

	test("returns an empty array when the section has no unchecked items", () => {
		const content = [
			"## Next small steps",
			"- [x] all done",
			"",
			"## Notes",
		].join("\n");
		expect(extractNextSteps(content)).toEqual([]);
	});

	test("stops at the next heading even without a trailing blank line", () => {
		const content = [
			"## Next small steps",
			"- [ ] keep me",
			"## Notes",
			"- [ ] not a next step",
		].join("\n");
		expect(extractNextSteps(content)).toEqual(["keep me"]);
	});
});

describe("filterRecentFiles", () => {
	const HOUR = 60 * 60 * 1000;
	const now = new Date("2026-07-04T12:00:00").getTime();

	function file(path: string, hoursAgo: number): DashboardFile {
		return { path, stat: { mtime: now - hoursAgo * HOUR } };
	}

	test("keeps files modified within the last 48 hours, drops older ones", () => {
		const files = [
			file("01 Projects/tracker-a.md", 1),
			file("01 Projects/tracker-b.md", 47),
			file("01 Projects/tracker-c.md", 49),
			file("01 Projects/tracker-d.md", 200),
		];

		const result = filterRecentFiles(files, now, [], "00 Start/Daily");

		expect(result.map((f) => f.path)).toEqual([
			"01 Projects/tracker-a.md",
			"01 Projects/tracker-b.md",
		]);
	});

	test("excludes configured exclude folders", () => {
		const files = [
			file("04 Dev Docs/note.md", 1),
			file("01 Projects/tracker.md", 1),
		];

		const result = filterRecentFiles(
			files,
			now,
			["04 Dev Docs"],
			"00 Start/Daily",
		);

		expect(result.map((f) => f.path)).toEqual(["01 Projects/tracker.md"]);
	});

	test("skips the daily folder itself", () => {
		const files = [
			file("00 Start/Daily/2026-07-03.md", 1),
			file("01 Projects/tracker.md", 1),
		];

		const result = filterRecentFiles(files, now, [], "00 Start/Daily");

		expect(result.map((f) => f.path)).toEqual(["01 Projects/tracker.md"]);
	});

	test("sorts most-recently-modified first", () => {
		const files = [file("older.md", 40), file("newer.md", 2)];

		const result = filterRecentFiles(files, now, [], "00 Start/Daily");

		expect(result.map((f) => f.path)).toEqual(["newer.md", "older.md"]);
	});
});

describe("localDateString", () => {
	test("formats a local date as YYYY-MM-DD", () => {
		expect(localDateString(new Date(2026, 6, 4))).toBe("2026-07-04");
		expect(localDateString(new Date(2026, 0, 9))).toBe("2026-01-09");
	});
});

describe("buildDailyNote", () => {
	test("assembles all sections with a summary present", () => {
		const markdown = buildDailyNote({
			date: "2026-07-04",
			changedFiles: [
				{ path: "01 Projects/tracker-a.md", mtime: 0 },
				{ path: "00 Start/Ideas.md", mtime: 0 },
			],
			trackerSteps: [
				{ name: "tracker-a", steps: ["ship the thing"] },
				{ name: "tracker-b", steps: [] },
			],
			summary: "Busy day across two trackers.",
		});

		expect(markdown).toContain("# Daily dashboard — 2026-07-04");
		expect(markdown).toContain("## Summary");
		expect(markdown).toContain("Busy day across two trackers.");
		expect(markdown).toContain("## Changed in the last 48 hours");
		expect(markdown).toContain("- 01 Projects/tracker-a.md");
		expect(markdown).toContain("- 00 Start/Ideas.md");
		expect(markdown).toContain("## Next small steps");
		expect(markdown).toContain("### tracker-a");
		expect(markdown).toContain("- [ ] ship the thing");
		// A tracker with no steps isn't rendered.
		expect(markdown).not.toContain("### tracker-b");
	});

	test("degrades the summary to a placeholder when null", () => {
		const markdown = buildDailyNote({
			date: "2026-07-04",
			changedFiles: [],
			trackerSteps: [],
			summary: null,
		});

		expect(markdown).toContain("Summary unavailable.");
	});

	test("degrades the summary to a placeholder when blank", () => {
		const markdown = buildDailyNote({
			date: "2026-07-04",
			changedFiles: [],
			trackerSteps: [],
			summary: "   ",
		});

		expect(markdown).toContain("Summary unavailable.");
	});

	test("renders 'Nothing captured.' for an empty day", () => {
		const markdown = buildDailyNote({
			date: "2026-07-04",
			changedFiles: [],
			trackerSteps: [],
			summary: null,
		});

		const nothingCapturedCount = (markdown.match(/Nothing captured\./g) ?? [])
			.length;
		expect(nothingCapturedCount).toBe(2);
	});
});

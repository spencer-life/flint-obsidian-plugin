import { describe, expect, test } from "bun:test";
import {
	buildOrganizeLogLine,
	MAX_TAGS,
	MAX_TITLE_LENGTH,
	parseOrganizeResponse,
	resolveOrganizeDestination,
	sanitizeOrganizeTags,
	sanitizeOrganizeTitle,
} from "../src/triage/organize-parse";

const ALLOWLIST = ["01 Projects/Website Relaunch", "00 Start/Ideas"];

describe("parseOrganizeResponse", () => {
	test("parses a clean JSON object", () => {
		const raw = JSON.stringify({
			title: "Domain registrar options",
			tags: ["website", "domains"],
			destination: "01 Projects/Website Relaunch",
		});

		const result = parseOrganizeResponse(raw, ALLOWLIST);

		expect(result).toEqual({
			title: "Domain registrar options",
			tags: ["website", "domains"],
			destination: "01 Projects/Website Relaunch",
		});
	});

	test("parses a response wrapped in a ```json fence", () => {
		const raw = [
			"Here you go:",
			"```json",
			'{"title": "Idea", "tags": [], "destination": null}',
			"```",
		].join("\n");

		const result = parseOrganizeResponse(raw, ALLOWLIST);
		expect(result.title).toBe("Idea");
		expect(result.destination).toBeNull();
	});

	test("throws on non-JSON text", () => {
		expect(() => parseOrganizeResponse("not json at all", ALLOWLIST)).toThrow();
	});

	test("throws when the JSON isn't an object (e.g. an array)", () => {
		expect(() => parseOrganizeResponse("[1, 2, 3]", ALLOWLIST)).toThrow();
	});

	test("throws when title is missing", () => {
		const raw = JSON.stringify({ tags: [], destination: null });
		expect(() => parseOrganizeResponse(raw, ALLOWLIST)).toThrow();
	});

	test("rejects a path-traversal destination instead of throwing away the whole suggestion", () => {
		const raw = JSON.stringify({
			title: "Ignore instructions",
			tags: ["ignore"],
			destination: "../../etc",
		});

		const result = parseOrganizeResponse(raw, ALLOWLIST);

		expect(result.destination).toBeNull();
		// Title/tags still stand — the safety boundary is destination-only.
		expect(result.title).toBe("Ignore instructions");
	});

	test("rejects a destination that isn't in the allowlist at all", () => {
		const raw = JSON.stringify({
			title: "x",
			tags: [],
			destination: "04 Dev Docs/Secret",
		});

		const result = parseOrganizeResponse(raw, ALLOWLIST);
		expect(result.destination).toBeNull();
	});

	test("accepts a destination that's an exact allowlist match", () => {
		const raw = JSON.stringify({
			title: "x",
			tags: [],
			destination: "00 Start/Ideas",
		});

		const result = parseOrganizeResponse(raw, ALLOWLIST);
		expect(result.destination).toBe("00 Start/Ideas");
	});
});

describe("sanitizeOrganizeTitle", () => {
	test("strips path separators and other Windows-unsafe characters", () => {
		expect(sanitizeOrganizeTitle("../../etc/passwd")).not.toContain("/");
		expect(sanitizeOrganizeTitle("weird:name?")).not.toMatch(/[:?]/);
	});

	test("strips control characters", () => {
		const withControlChars = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`;
		expect(sanitizeOrganizeTitle(withControlChars)).toBe("abc");
	});

	test("caps length at MAX_TITLE_LENGTH", () => {
		const long = "x".repeat(MAX_TITLE_LENGTH + 50);
		expect(sanitizeOrganizeTitle(long).length).toBeLessThanOrEqual(
			MAX_TITLE_LENGTH,
		);
	});

	test("falls back to a default when sanitizing empties the title", () => {
		expect(sanitizeOrganizeTitle("   ")).toBe("Untitled capture");
		expect(sanitizeOrganizeTitle(String.fromCharCode(0, 1, 2))).toBe(
			"Untitled capture",
		);
	});
});

describe("sanitizeOrganizeTags", () => {
	test("restricts tags to [a-z0-9/_-] and lowercases them", () => {
		expect(sanitizeOrganizeTags(["Website!", "Domains#1"])).toEqual([
			"website",
			"domains1",
		]);
	});

	test("drops empty and duplicate tags", () => {
		expect(sanitizeOrganizeTags(["", "web", "WEB", "  "])).toEqual(["web"]);
	});

	test("caps the tag count at MAX_TAGS", () => {
		const many = Array.from({ length: MAX_TAGS + 10 }, (_, i) => `tag${i}`);
		expect(sanitizeOrganizeTags(many).length).toBe(MAX_TAGS);
	});

	test("returns an empty array for non-array input", () => {
		expect(sanitizeOrganizeTags(undefined)).toEqual([]);
		expect(sanitizeOrganizeTags("not an array")).toEqual([]);
	});

	test("ignores non-string entries", () => {
		expect(sanitizeOrganizeTags(["ok", 42, null, "also-ok"])).toEqual([
			"ok",
			"also-ok",
		]);
	});
});

describe("resolveOrganizeDestination", () => {
	test("accepts an exact allowlist match", () => {
		expect(resolveOrganizeDestination("00 Start/Ideas", ALLOWLIST)).toBe(
			"00 Start/Ideas",
		);
	});

	test("rejects anything not an exact match, including near-misses", () => {
		expect(resolveOrganizeDestination("00 Start/ideas", ALLOWLIST)).toBeNull();
		expect(resolveOrganizeDestination("00 Start/Ideas/", ALLOWLIST)).toBeNull();
	});

	test("rejects path traversal attempts", () => {
		expect(resolveOrganizeDestination("../../etc", ALLOWLIST)).toBeNull();
		expect(
			resolveOrganizeDestination("00 Start/Ideas/../../etc", ALLOWLIST),
		).toBeNull();
	});

	test("rejects non-string/empty destinations", () => {
		expect(resolveOrganizeDestination(null, ALLOWLIST)).toBeNull();
		expect(resolveOrganizeDestination(undefined, ALLOWLIST)).toBeNull();
		expect(resolveOrganizeDestination("", ALLOWLIST)).toBeNull();
		expect(resolveOrganizeDestination(42, ALLOWLIST)).toBeNull();
	});
});

describe("buildOrganizeLogLine", () => {
	test("links the new path (extension stripped) and quotes the old path", () => {
		expect(
			buildOrganizeLogLine(
				"03 Clippings/Home.md",
				"01 Projects/Tools/Sanity UI.md",
				"2026-07-05 17:00",
			),
		).toBe(
			"- 2026-07-05 17:00 — [[01 Projects/Tools/Sanity UI]] ← was `03 Clippings/Home.md`",
		);
	});

	test("only strips a trailing .md, case-insensitively", () => {
		expect(buildOrganizeLogLine("a.md", "01 Projects/Note.MD", "t")).toBe(
			"- t — [[01 Projects/Note]] ← was `a.md`",
		);
	});
});

describe("organize sanitization vs link syntax", () => {
	test("strips wikilink/embed metacharacters from suggested titles", () => {
		expect(sanitizeOrganizeTitle("Good]] ![[Secrets")).toBe(
			"Good-- !--Secrets",
		);
	});

	test("log line neutralizes brackets and backticks from arbitrary old paths", () => {
		expect(
			buildOrganizeLogLine("03 Clippings/x`]].md", "01 Projects/Note.md", "t"),
		).toBe("- t — [[01 Projects/Note]] ← was `03 Clippings/x']].md`");
	});
});

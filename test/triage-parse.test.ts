import { describe, expect, test } from "bun:test";
import {
	extractBullets,
	NEXT_STEP_MAX_LENGTH,
	parseTriageResponse,
	sanitizeNextStep,
} from "../src/triage/parse";

describe("extractBullets", () => {
	test("extracts QuickAdd-style timestamped bullets", () => {
		const content = [
			"# Inbox",
			"- 2026-07-04 14:22 — buy a domain for the site",
			"- 2026-07-04 09:00 - call the dentist",
		].join("\n");

		const bullets = extractBullets(content);

		expect(bullets).toHaveLength(2);
		expect(bullets[0]?.item).toBe("buy a domain for the site");
		expect(bullets[0]?.raw).toBe(
			"- 2026-07-04 14:22 — buy a domain for the site",
		);
		expect(bullets[1]?.item).toBe("call the dentist");
	});

	test("extracts plain bullets without a timestamp prefix", () => {
		const bullets = extractBullets("- water the plants");
		expect(bullets).toHaveLength(1);
		expect(bullets[0]?.item).toBe("water the plants");
	});

	test("ignores non-bullet lines: headings, blanks, and task lines", () => {
		const content = [
			"## 👉 Next small steps",
			"",
			"- [ ] already a routed task (from: something)",
			"- [x] done task",
			"Some prose that isn't a bullet.",
			"- 2026-07-04 08:00 — a real capture item",
		].join("\n");

		const bullets = extractBullets(content);

		expect(bullets).toHaveLength(1);
		expect(bullets[0]?.item).toBe("a real capture item");
	});

	test("returns an empty array for an empty/whitespace-only note", () => {
		expect(extractBullets("")).toEqual([]);
		expect(extractBullets("\n\n   \n")).toEqual([]);
	});
});

describe("parseTriageResponse", () => {
	test("parses a clean JSON array", () => {
		const raw = JSON.stringify([
			{
				item: "buy a domain",
				target: "01 Projects/Site.md",
				nextStep: "search a registrar",
			},
		]);

		const result = parseTriageResponse(raw);

		expect(result).toEqual([
			{
				item: "buy a domain",
				target: "01 Projects/Site.md",
				nextStep: "search a registrar",
			},
		]);
	});

	test("parses a response wrapped in a ```json fence", () => {
		const raw = [
			"Here you go:",
			"```json",
			'[{"item": "call dentist", "target": "unsorted", "nextStep": "look up phone number"}]',
			"```",
		].join("\n");

		const result = parseTriageResponse(raw);

		expect(result).toEqual([
			{
				item: "call dentist",
				target: "unsorted",
				nextStep: "look up phone number",
			},
		]);
	});

	test("parses a response wrapped in a plain ``` fence (no 'json' tag)", () => {
		const raw = '```\n[{"item": "x", "target": "ideas", "nextStep": "y"}]\n```';
		const result = parseTriageResponse(raw);
		expect(result).toEqual([{ item: "x", target: "ideas", nextStep: "y" }]);
	});

	test("throws on non-JSON text", () => {
		expect(() => parseTriageResponse("not json at all")).toThrow();
	});

	test("throws when the JSON isn't an array", () => {
		expect(() => parseTriageResponse('{"item": "x"}')).toThrow();
	});

	test("throws when an entry is missing a required field", () => {
		const raw = JSON.stringify([{ item: "x", target: "ideas" }]);
		expect(() => parseTriageResponse(raw)).toThrow();
	});

	test("sanitizes an injected multi-line/markdown nextStep before returning it", () => {
		const raw = JSON.stringify([
			{
				item: "x",
				target: "ideas",
				nextStep: "# Fake heading\n- fake bullet\ndo the actual thing",
			},
		]);

		const result = parseTriageResponse(raw);

		expect(result[0]?.nextStep).not.toContain("\n");
		expect(result[0]?.nextStep?.startsWith("\\#")).toBe(true);
	});
});

describe("sanitizeNextStep", () => {
	test("collapses newlines and control characters into a single line", () => {
		expect(sanitizeNextStep("line one\nline two\r\nline three")).toBe(
			"line one line two line three",
		);

		// Embed a NUL and a BEL control character without putting a raw
		// control byte in the source file itself.
		const withControlChars = `a${String.fromCharCode(0)}b${String.fromCharCode(7)}c`;
		expect(sanitizeNextStep(withControlChars)).toBe("abc");
	});

	test("collapses repeated whitespace", () => {
		expect(sanitizeNextStep("too    many   spaces")).toBe("too many spaces");
	});

	test("escapes a leading heading marker", () => {
		expect(sanitizeNextStep("# not a heading")).toBe("\\# not a heading");
	});

	test("escapes a leading list/blockquote marker", () => {
		expect(sanitizeNextStep("- not a bullet")).toBe("\\- not a bullet");
		expect(sanitizeNextStep("* not a bullet")).toBe("\\* not a bullet");
		expect(sanitizeNextStep("> not a quote")).toBe("\\> not a quote");
	});

	test("escapes a leading task checkbox", () => {
		expect(sanitizeNextStep("[ ] not a checkbox")).toBe("\\[ ] not a checkbox");
		expect(sanitizeNextStep("[x] not a checkbox")).toBe("\\[x] not a checkbox");
	});

	test("leaves an ordinary sentence untouched", () => {
		expect(sanitizeNextStep("search a domain registrar")).toBe(
			"search a domain registrar",
		);
	});

	test("caps length at NEXT_STEP_MAX_LENGTH", () => {
		const long = "x".repeat(NEXT_STEP_MAX_LENGTH + 50);
		const result = sanitizeNextStep(long);
		expect(result.length).toBeLessThanOrEqual(NEXT_STEP_MAX_LENGTH);
	});
});

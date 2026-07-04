import { describe, expect, test } from "bun:test";
import { extractBullets, parseTriageResponse } from "../src/triage/parse";

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
});

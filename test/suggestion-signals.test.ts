import { describe, expect, test } from "bun:test";
import { computeSuggestions } from "../src/react/suggestion-signals";

describe("computeSuggestions", () => {
	test("surfaces organize and review cards when there's backlog", () => {
		const suggestions = computeSuggestions({
			unfiledCount: 7,
			pendingSuggestionCount: 3,
			topRecentTag: "insurance",
		});
		const ids = suggestions.map((s) => s.id);
		expect(ids).toEqual([
			"organize-backlog",
			"review-suggestions",
			"yesterday",
			"top-tag",
		]);
		expect(suggestions[0]?.title).toBe("Organize 7 unfiled captures");
		expect(suggestions[1]?.title).toBe("Review 3 filing suggestions");
		expect(suggestions[3]?.title).toBe("Catch me up on #insurance");
	});

	test("singular grammar for a single item", () => {
		const suggestions = computeSuggestions({
			unfiledCount: 1,
			pendingSuggestionCount: 1,
		});
		expect(suggestions[0]?.title).toBe("Organize 1 unfiled capture");
		expect(suggestions[1]?.title).toBe("Review 1 filing suggestion");
	});

	test("falls back to seed prompts when the vault is quiet", () => {
		const suggestions = computeSuggestions({
			unfiledCount: 0,
			pendingSuggestionCount: 0,
		});
		expect(suggestions.length).toBeGreaterThanOrEqual(3);
		expect(suggestions.every((s) => s.action.kind === "seed")).toBe(true);
	});

	test("caps at 4 cards", () => {
		const suggestions = computeSuggestions({
			unfiledCount: 5,
			pendingSuggestionCount: 5,
			topRecentTag: "x",
		});
		expect(suggestions.length).toBeLessThanOrEqual(4);
	});
});

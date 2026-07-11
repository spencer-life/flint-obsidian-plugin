import { describe, expect, test } from "bun:test";
import "./obsidian-mock";

const { buildSummaryPrompt } = await import("../src/dashboard/daily");

describe("buildSummaryPrompt", () => {
	test("does not include the Obsidian capabilities catalog (summary prompt, no write manual needed)", () => {
		const messages = buildSummaryPrompt([
			{ path: "01 Projects/rocket.md", excerpt: "Liquid fuel is dense." },
		]);
		const system = messages[0];
		if (!system) throw new Error("expected a system message");

		expect(system.role).toBe("system");
		expect(system.content).not.toContain("What Obsidian can render and do");
	});
});

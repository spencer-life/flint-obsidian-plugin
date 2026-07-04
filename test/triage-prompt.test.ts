import { describe, expect, test } from "bun:test";
import { buildTriagePrompt } from "../src/triage/prompt";

describe("buildTriagePrompt", () => {
	test("includes every item and every tracker in the user message", () => {
		const messages = buildTriagePrompt(
			["buy a domain", "call the dentist"],
			[
				{ path: "01 Projects/Site.md", name: "Site" },
				{ path: "01 Projects/Health.md", name: "Health" },
			],
		);

		const user = messages.find((m) => m.role === "user");
		expect(user).toBeDefined();
		expect(user?.content).toContain("buy a domain");
		expect(user?.content).toContain("call the dentist");
		expect(user?.content).toContain("01 Projects/Site.md");
		expect(user?.content).toContain("01 Projects/Health.md");
	});

	test("includes a system message instructing strict JSON output", () => {
		const messages = buildTriagePrompt(["item"], []);
		const system = messages.find((m) => m.role === "system");
		expect(system?.content).toContain("JSON");
	});

	test("notes when there are no active trackers", () => {
		const messages = buildTriagePrompt(["item"], []);
		const user = messages.find((m) => m.role === "user");
		expect(user?.content).toContain("no active project trackers");
	});
});

import { describe, expect, test } from "bun:test";
import "./obsidian-mock";

const { buildAgentSystemPrompt } = await import("../src/agent/system-prompt");

describe("buildAgentSystemPrompt", () => {
	test("includes the Obsidian capabilities brief", () => {
		const prompt = buildAgentSystemPrompt({
			folderTree: "01 Projects\n02 Areas",
			settings: {
				captureFolder: "00 Inbox",
				clippingsFolder: "00 Inbox/Clippings",
				projectsFolder: "01 Projects",
				dailyFolder: "03 Daily",
			},
		});

		expect(prompt).toContain("What Obsidian can render and do");
	});
});

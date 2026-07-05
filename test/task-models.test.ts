import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import type FlintPlugin from "../src/main";
import { createFakeApp } from "./fake-vault";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { DEFAULT_SETTINGS, resolveTaskModel } = await import("../src/settings");
const { TriageService } = await import("../src/triage/triage");

beforeEach(() => {
	resetObsidianMock();
});

function cloneSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

describe("resolveTaskModel", () => {
	test("falls back to activeModel when the task override is empty", () => {
		const settings = cloneSettings();
		settings.activeModel = "claude-sonnet-4-5";
		expect(resolveTaskModel(settings, "triage")).toBe("claude-sonnet-4-5");
	});

	test("falls back to activeModel when the task override is whitespace-only", () => {
		const settings = cloneSettings();
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.organize = "   ";
		expect(resolveTaskModel(settings, "organize")).toBe("claude-sonnet-4-5");
	});

	test("uses the task override when set", () => {
		const settings = cloneSettings();
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.dashboard = "google/gemma-3-12b-it";
		expect(resolveTaskModel(settings, "dashboard")).toBe(
			"google/gemma-3-12b-it",
		);
	});
});

describe("triage uses resolveTaskModel", () => {
	test("sends the triage task-model override in the request body when set", async () => {
		const app = createFakeApp([
			{
				path: "00 Start/Inbox.md",
				content: "- buy a domain for the rocket project",
			},
		]);

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.triage = "deepseek-ai/deepseek-v4-flash";
		settings.inboxNotes = ["00 Start/Inbox.md"];

		const plugin = { app, settings } as unknown as FlintPlugin;
		const service = new TriageService(plugin);

		setRequestUrlHandler(() => ({
			json: {
				content: [
					{
						text: JSON.stringify([
							{
								item: "buy a domain for the rocket project",
								target: "unsorted",
								nextStep: "buy a domain",
							},
						]),
					},
				],
			},
		}));

		await service.buildPlan();

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.model).toBe("deepseek-ai/deepseek-v4-flash");
	});

	test("falls back to the active model when no triage override is set", async () => {
		const app = createFakeApp([
			{
				path: "00 Start/Inbox.md",
				content: "- buy a domain for the rocket project",
			},
		]);

		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.activeModel = "claude-sonnet-4-5";
		settings.inboxNotes = ["00 Start/Inbox.md"];

		const plugin = { app, settings } as unknown as FlintPlugin;
		const service = new TriageService(plugin);

		setRequestUrlHandler(() => ({
			json: {
				content: [
					{
						text: JSON.stringify([
							{
								item: "buy a domain for the rocket project",
								target: "unsorted",
								nextStep: "buy a domain",
							},
						]),
					},
				],
			},
		}));

		await service.buildPlan();

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.model).toBe("claude-sonnet-4-5");
	});
});

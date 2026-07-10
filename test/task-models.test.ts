import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import type FlintPlugin from "../src/main";
import { createFakeApp } from "./fake-vault";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const {
	DEFAULT_SETTINGS,
	loadSettingsFromRaw,
	migrateTaskModels,
	resolveTaskModel,
	SETTINGS_VERSION,
} = await import("../src/settings");
const { chatWithTaskModel } = await import("../src/providers");
const { TriageService } = await import("../src/triage/triage");

beforeEach(() => {
	resetObsidianMock();
});

function cloneSettings() {
	return structuredClone(DEFAULT_SETTINGS);
}

describe("resolveTaskModel", () => {
	test("falls back to activeModel on the active provider when the override is empty", () => {
		const settings = cloneSettings();
		settings.activeProvider = "nim";
		settings.activeModel = "minimaxai/minimax-m3";
		expect(resolveTaskModel(settings, "triage")).toEqual({
			providerId: "nim",
			model: "minimaxai/minimax-m3",
		});
	});

	test("falls back when the override model is whitespace-only", () => {
		const settings = cloneSettings();
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.organize = { providerId: "nim", model: "   " };
		expect(resolveTaskModel(settings, "organize")).toEqual({
			providerId: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});

	test("uses the override's own provider when pinned", () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.dashboard = {
			providerId: "nim",
			model: "google/gemma-3-12b-it",
		};
		expect(resolveTaskModel(settings, "dashboard")).toEqual({
			providerId: "nim",
			model: "google/gemma-3-12b-it",
		});
	});

	test("an override with a model but empty provider runs on the active provider", () => {
		const settings = cloneSettings();
		settings.activeProvider = "openai";
		settings.taskModels.triage = { providerId: "", model: "gpt-4.1-mini" };
		expect(resolveTaskModel(settings, "triage")).toEqual({
			providerId: "openai",
			model: "gpt-4.1-mini",
		});
	});

	test("empty vision override falls back to the active chat model, same as any other task", () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.vision = { providerId: "", model: "" };
		expect(resolveTaskModel(settings, "vision")).toEqual({
			providerId: "anthropic",
			model: "claude-sonnet-4-5",
		});
	});
});

describe("migrateTaskModels", () => {
	test("converts legacy string overrides, pinning them to the legacy provider", () => {
		const migrated = migrateTaskModels(
			{
				triage: "deepseek-ai/deepseek-v4-flash",
				organize: "deepseek-ai/deepseek-v4-flash",
				dashboard: "google/gemma-3-12b-it",
				htmlGenerate: "",
			},
			"nim",
		);
		expect(migrated.triage).toEqual({
			providerId: "nim",
			model: "deepseek-ai/deepseek-v4-flash",
		});
		expect(migrated.dashboard).toEqual({
			providerId: "nim",
			model: "google/gemma-3-12b-it",
		});
		expect(migrated.htmlGenerate).toEqual({ providerId: "", model: "" });
	});

	test("passes through already-migrated object overrides", () => {
		const migrated = migrateTaskModels(
			{ triage: { providerId: "openai", model: "gpt-4.1" } },
			"nim",
		);
		expect(migrated.triage).toEqual({ providerId: "openai", model: "gpt-4.1" });
		expect(migrated.organize).toEqual({ providerId: "", model: "" });
	});

	test("degrades garbage (wrong types, bogus providers) to empty overrides", () => {
		const migrated = migrateTaskModels(
			{
				triage: 42,
				organize: { providerId: "not-a-provider", model: 7 },
				dashboard: null,
			},
			"nim",
		);
		expect(migrated.triage).toEqual({ providerId: "", model: "" });
		expect(migrated.organize).toEqual({ providerId: "", model: "" });
		expect(migrated.dashboard).toEqual({ providerId: "", model: "" });
	});

	test("returns all-empty overrides for non-object input", () => {
		const migrated = migrateTaskModels(undefined, "anthropic");
		expect(migrated.triage).toEqual({ providerId: "", model: "" });
	});
});

describe("loadSettingsFromRaw", () => {
	test("fresh install (null raw): generic defaults, no migration, no Spencer seeds", () => {
		const result = loadSettingsFromRaw(null);
		expect(result.migrated).toBe(false);
		expect(result.autoApplyDisabled).toBe(false);
		expect(result.settings.organizeExcludeFolders).toEqual(["Templates"]);
		expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	test("legacy data (no settingsVersion): flips a live auto-apply off, seeds exclusions, migrates task models, stamps the version", () => {
		const result = loadSettingsFromRaw({
			activeProvider: "nim",
			activeModel: "minimaxai/minimax-m3",
			organizeAutoApply: true,
			taskModels: {
				triage: "deepseek-ai/deepseek-v4-flash",
				organize: "deepseek-ai/deepseek-v4-flash",
				dashboard: "google/gemma-3-12b-it",
				htmlGenerate: "",
			},
		});
		expect(result.migrated).toBe(true);
		expect(result.autoApplyDisabled).toBe(true);
		expect(result.settings.organizeAutoApply).toBe(false);
		expect(result.settings.organizeExcludeFolders).toEqual([
			"02 Claude",
			"06 Templates",
		]);
		expect(result.settings.taskModels.organize).toEqual({
			providerId: "nim",
			model: "deepseek-ai/deepseek-v4-flash",
		});
		expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
	});

	test("legacy data with auto-apply already off migrates without the Notice flag", () => {
		const result = loadSettingsFromRaw({ organizeAutoApply: false });
		expect(result.migrated).toBe(true);
		expect(result.autoApplyDisabled).toBe(false);
	});

	test("current-version data is not re-migrated (no Spencer seeds, no rewrite)", () => {
		const result = loadSettingsFromRaw({
			settingsVersion: SETTINGS_VERSION,
			organizeAutoApply: true,
			organizeExcludeFolders: ["Custom"],
			taskModels: {
				triage: { providerId: "nim", model: "x" },
			},
		});
		expect(result.migrated).toBe(false);
		expect(result.autoApplyDisabled).toBe(false);
		// A v2 user who deliberately re-enabled auto-apply keeps it.
		expect(result.settings.organizeAutoApply).toBe(true);
		expect(result.settings.organizeExcludeFolders).toEqual(["Custom"]);
		expect(result.settings.taskModels.triage).toEqual({
			providerId: "nim",
			model: "x",
		});
	});

	describe("v2 -> v3: NIM deepseek-v4-pro chat model rewrite", () => {
		test("v2 nim + deepseek-v4-pro chains through v3 (m3) and v4 to minimax-m2.7", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 2,
				activeProvider: "nim",
				activeModel: "deepseek-ai/deepseek-v4-pro",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m2.7");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
			expect(result.migrated).toBe(true);
		});

		test("leaves a different NIM model untouched", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 2,
				activeProvider: "nim",
				activeModel: "google/gemma-3-12b-it",
			});
			expect(result.settings.activeModel).toBe("google/gemma-3-12b-it");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});

		test("leaves deepseek-v4-pro on a non-NIM provider untouched", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 2,
				activeProvider: "ollama",
				activeModel: "deepseek-ai/deepseek-v4-pro",
			});
			expect(result.settings.activeModel).toBe("deepseek-ai/deepseek-v4-pro");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});

		test("leaves task models untouched by the chat-model rewrite", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 2,
				activeProvider: "nim",
				activeModel: "deepseek-ai/deepseek-v4-pro",
				taskModels: {
					triage: { providerId: "nim", model: "deepseek-ai/deepseek-v4-flash" },
				},
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m2.7");
			expect(result.settings.taskModels.triage).toEqual({
				providerId: "nim",
				model: "deepseek-ai/deepseek-v4-flash",
			});
		});

		test("already-current data with nim + deepseek-v4-pro is NOT re-migrated (rewrite is one-shot, not a standing guard)", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: SETTINGS_VERSION,
				activeProvider: "nim",
				activeModel: "deepseek-ai/deepseek-v4-pro",
			});
			expect(result.settings.activeModel).toBe("deepseek-ai/deepseek-v4-pro");
			expect(result.migrated).toBe(false);
		});
	});

	describe("v3 -> v4: NIM minimax-m3 (DEGRADED endpoint) chat model rewrite", () => {
		test("rewrites activeModel to minimax-m2.7 for nim + minimax-m3 at v3", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 3,
				activeProvider: "nim",
				activeModel: "minimaxai/minimax-m3",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m2.7");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
			expect(result.migrated).toBe(true);
		});

		test("leaves a different NIM model untouched at v3", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 3,
				activeProvider: "nim",
				activeModel: "minimaxai/minimax-m2.7",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m2.7");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});

		test("leaves minimax-m3 on a non-NIM provider untouched", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 3,
				activeProvider: "openai",
				activeModel: "minimaxai/minimax-m3",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m3");
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});

		test("already-v4 data with nim + minimax-m3 is NOT re-migrated (user may re-pick m3 deliberately)", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: SETTINGS_VERSION,
				activeProvider: "nim",
				activeModel: "minimaxai/minimax-m3",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m3");
			expect(result.migrated).toBe(false);
		});
	});

	describe("v4 -> v5: vision task model seed + dashboard/htmlGenerate -> glm-5.2", () => {
		test("seeds vision unconditionally to nim + nemotron-nano-12b-v2-vl", () => {
			const result = loadSettingsFromRaw({ settingsVersion: 4 });
			expect(result.settings.taskModels.vision).toEqual({
				providerId: "nim",
				model: "nvidia/nemotron-nano-12b-v2-vl",
			});
			expect(result.migrated).toBe(true);
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});

		test("rewrites the deprecated gemma suggestion (pinned to nim) to glm-5.2", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 4,
				taskModels: {
					dashboard: { providerId: "nim", model: "google/gemma-3-12b-it" },
				},
			});
			expect(result.settings.taskModels.dashboard).toEqual({
				providerId: "nim",
				model: "z-ai/glm-5.2",
			});
		});

		test("rewrites an empty htmlGenerate override to glm-5.2", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 4,
				taskModels: { htmlGenerate: { providerId: "", model: "" } },
			});
			expect(result.settings.taskModels.htmlGenerate).toEqual({
				providerId: "nim",
				model: "z-ai/glm-5.2",
			});
		});

		test("leaves a custom dashboard override untouched", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 4,
				taskModels: {
					dashboard: { providerId: "openai", model: "gpt-4o" },
				},
			});
			expect(result.settings.taskModels.dashboard).toEqual({
				providerId: "openai",
				model: "gpt-4o",
			});
		});

		test("leaves the gemma suggestion untouched when pinned to a non-NIM provider", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: 4,
				taskModels: {
					htmlGenerate: {
						providerId: "openai",
						model: "google/gemma-3-12b-it",
					},
				},
			});
			expect(result.settings.taskModels.htmlGenerate).toEqual({
				providerId: "openai",
				model: "google/gemma-3-12b-it",
			});
		});

		test("already-v5 data with an emptied vision override is NOT re-seeded (one-shot)", () => {
			const result = loadSettingsFromRaw({
				settingsVersion: SETTINGS_VERSION,
				taskModels: { vision: { providerId: "", model: "" } },
			});
			expect(result.settings.taskModels.vision).toEqual({
				providerId: "",
				model: "",
			});
			expect(result.migrated).toBe(false);
		});

		test("v0 (no settingsVersion) chains v2 -> v5 in one load", () => {
			const result = loadSettingsFromRaw({
				activeProvider: "nim",
				activeModel: "deepseek-ai/deepseek-v4-pro",
			});
			expect(result.settings.activeModel).toBe("minimaxai/minimax-m2.7");
			expect(result.settings.taskModels.vision).toEqual({
				providerId: "nim",
				model: "nvidia/nemotron-nano-12b-v2-vl",
			});
			expect(result.settings.settingsVersion).toBe(SETTINGS_VERSION);
		});
	});
});

describe("chatWithTaskModel provider routing", () => {
	test("an override pinned to another provider calls THAT provider's endpoint", async () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.providers.nim.apiKey = "nvapi-test";
		settings.taskModels.organize = {
			providerId: "nim",
			model: "deepseek-ai/deepseek-v4-flash",
		};

		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "ok" } }] },
		}));

		const reply = await chatWithTaskModel(settings, "organize", [
			{ role: "user", content: "hi" },
		]);

		expect(reply).toBe("ok");
		expect(requestUrlCalls[0]?.url).toContain("integrate.api.nvidia.com");
		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.model).toBe("deepseek-ai/deepseek-v4-flash");
	});

	test("a failed override falls back to the chat model on the ACTIVE provider", async () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.providers.nim.apiKey = "nvapi-test";
		settings.taskModels.triage = {
			providerId: "nim",
			model: "gone/does-not-exist",
		};

		setRequestUrlHandler((params) => {
			if (params.url.includes("nvidia")) {
				return {
					json: { error: { message: "model not found" } },
					status: 404,
				};
			}
			return { json: { content: [{ text: "fallback answer" }] } };
		});

		const reply = await chatWithTaskModel(settings, "triage", [
			{ role: "user", content: "hi" },
		]);

		expect(reply).toBe("fallback answer");
		expect(requestUrlCalls[0]?.url).toContain("nvidia");
		expect(requestUrlCalls[1]?.url).toContain("anthropic.com");
		const fallbackBody = JSON.parse(requestUrlCalls[1]?.body ?? "{}");
		expect(fallbackBody.model).toBe("claude-sonnet-4-5");
	});
});

describe("chatWithTaskModel applies TASK_CHAT_DEFAULTS", () => {
	test("triage on NIM deepseek-v4-flash: temperature 0.2 + nonthink kwargs", async () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.providers.nim.apiKey = "nvapi-test";
		settings.taskModels.triage = {
			providerId: "nim",
			model: "deepseek-ai/deepseek-v4-flash",
		};

		setRequestUrlHandler(() => ({
			json: { choices: [{ message: { content: "ok" } }] },
		}));

		await chatWithTaskModel(settings, "triage", [
			{ role: "user", content: "hi" },
		]);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.temperature).toBe(0.2);
		expect(body.chat_template_kwargs).toEqual({
			enable_thinking: false,
			thinking: false,
		});
	});

	test("dashboard task call carries max_tokens 8192", async () => {
		const settings = cloneSettings();
		settings.activeProvider = "anthropic";
		settings.activeModel = "claude-sonnet-4-5";
		settings.providers.anthropic.apiKey = "sk-ant-test";
		settings.taskModels.dashboard = {
			providerId: "anthropic",
			model: "claude-sonnet-4-5",
		};

		setRequestUrlHandler(() => ({ json: { content: [{ text: "ok" }] } }));

		await chatWithTaskModel(settings, "dashboard", [
			{ role: "user", content: "hi" },
		]);

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.max_tokens).toBe(8192);
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
		settings.providers.nim.apiKey = "nvapi-test";
		settings.activeModel = "claude-sonnet-4-5";
		settings.taskModels.triage = {
			providerId: "nim",
			model: "deepseek-ai/deepseek-v4-flash",
		};
		settings.inboxNotes = ["00 Start/Inbox.md"];

		const plugin = { app, settings } as unknown as FlintPlugin;
		const service = new TriageService(plugin);

		setRequestUrlHandler(() => ({
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify([
								{
									item: "buy a domain for the rocket project",
									target: "unsorted",
									nextStep: "buy a domain",
								},
							]),
						},
					},
				],
			},
		}));

		await service.buildPlan();

		const body = JSON.parse(requestUrlCalls[0]?.body ?? "{}");
		expect(body.model).toBe("deepseek-ai/deepseek-v4-flash");
		expect(requestUrlCalls[0]?.url).toContain("integrate.api.nvidia.com");
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

import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FlintPlugin from "./main";
import { fetchModels } from "./providers";
import { validateBaseUrl } from "./providers/openai-compatible";
import { ModelSuggest } from "./ui/model-suggest";

export type ProviderId = "anthropic" | "nim" | "openai" | "ollama";
export type Ambition = "lean" | "balanced" | "ambitious";
export type EmbeddingProviderId = "openai" | "nim" | "ollama" | "none";
export type OrganizeConfidence = "high" | "medium" | "low";

const PROVIDER_IDS: readonly ProviderId[] = [
	"anthropic",
	"nim",
	"openai",
	"ollama",
];

export function isProviderId(value: unknown): value is ProviderId {
	return (
		typeof value === "string" && (PROVIDER_IDS as string[]).includes(value)
	);
}

/**
 * A per-task model override. `providerId: ""` means "the active provider" —
 * a model id alone is ambiguous once overrides can outlive provider switches,
 * which is exactly the stale-override hazard this shape removes.
 */
export interface TaskModelOverride {
	providerId: ProviderId | "";
	model: string;
}

export interface FlintSettings {
	providers: {
		anthropic: { apiKey: string };
		nim: { apiKey: string };
		openai: { apiKey: string; baseUrl: string };
		ollama: { baseUrl: string };
	};
	activeProvider: ProviderId;
	activeModel: string;
	ambition: Ambition;
	useEmbeddings: boolean;
	embeddingProvider: EmbeddingProviderId;
	embeddingModel: string;
	embeddingDimensions: number;
	excludeFolders: string[];
	clippingsFolder: string;
	streamResponses: boolean;
	retrievalCount: number;
	ingestEnabled: boolean;
	firecrawlApiKey: string;
	inboxNotes: string[];
	projectsFolder: string;
	autoTriage: boolean;
	autoTriageIntervalMinutes: number;
	autoTriageAutoApply: boolean;
	captureFolder: string;
	organizeEnabled: boolean;
	organizeAutoApply: boolean;
	/** Folders excluded as ORGANIZE DESTINATIONS (distinct from the retrieval
	 * `excludeFolders` above — both are unioned when building the allowlist). */
	organizeExcludeFolders: string[];
	/** Vault path of a human-authored note describing folder conventions, fed
	 * to the organize prompt as guidance (never as instructions). */
	filingGuideNote: string;
	/** Minimum LLM-reported confidence required before a suggested destination
	 * is written to frontmatter at all. */
	organizeMinConfidence: OrganizeConfidence;
	/** Chat panel runs the tool-calling agent loop (with per-change Apply/Skip
	 * confirmation) instead of the read-only RAG pipeline. */
	agentMode: boolean;
	/** Bumped when stored data needs a one-shot migration on load. */
	settingsVersion: number;
	dailyFolder: string;
	dailyAutoGenerate: boolean;
	imageProvider: "nim" | "openai";
	imageModel: string;
	imageSize: string;
	taskModels: {
		triage: TaskModelOverride;
		organize: TaskModelOverride;
		dashboard: TaskModelOverride;
		htmlGenerate: TaskModelOverride;
	};
}

/** The per-task model tasks `resolveTaskModel` knows how to look up. */
export type TaskModelKey = keyof FlintSettings["taskModels"];

/** A fully-resolved (provider, model) pair ready to build a provider from. */
export interface ResolvedTaskModel {
	providerId: ProviderId;
	model: string;
}

/**
 * Per-task model override, falling back to the chat `activeModel` on the
 * active provider when the task's override is empty or whitespace-only — the
 * default, no-behavior-change state until a user explicitly assigns one. An
 * override with a model but no provider belongs to the active provider.
 */
export function resolveTaskModel(
	settings: FlintSettings,
	task: TaskModelKey,
): ResolvedTaskModel {
	const override = settings.taskModels[task];
	const model = override.model.trim();
	if (model.length === 0) {
		return {
			providerId: settings.activeProvider,
			model: settings.activeModel,
		};
	}
	return {
		providerId:
			override.providerId === ""
				? settings.activeProvider
				: override.providerId,
		model,
	};
}

/**
 * Normalizes a stored `taskModels` blob of ANY vintage to the current
 * `{providerId, model}` shape. Legacy plain-string overrides are assumed to
 * belong to `legacyProvider` (the provider that was active when they were
 * written — best available guess, and exactly what the old runtime did).
 * Pure and unit-testable; never throws on garbage.
 */
export function migrateTaskModels(
	raw: unknown,
	legacyProvider: ProviderId,
): FlintSettings["taskModels"] {
	const result: FlintSettings["taskModels"] = {
		triage: { providerId: "", model: "" },
		organize: { providerId: "", model: "" },
		dashboard: { providerId: "", model: "" },
		htmlGenerate: { providerId: "", model: "" },
	};
	if (typeof raw !== "object" || raw === null) return result;

	for (const key of Object.keys(result) as TaskModelKey[]) {
		const value = (raw as Record<string, unknown>)[key];
		if (typeof value === "string") {
			const model = value.trim();
			if (model.length > 0) {
				result[key] = { providerId: legacyProvider, model };
			}
		} else if (typeof value === "object" && value !== null) {
			const entry = value as Record<string, unknown>;
			result[key] = {
				providerId: isProviderId(entry["providerId"])
					? entry["providerId"]
					: "",
				model: typeof entry["model"] === "string" ? entry["model"] : "",
			};
		}
	}
	return result;
}

/** Current `settingsVersion` written by this build. */
export const SETTINGS_VERSION = 2;

export interface SettingsLoadResult {
	settings: FlintSettings;
	/** True when a one-shot migration ran — the caller should `saveData` once. */
	migrated: boolean;
	/** True when the migration flipped a live `organizeAutoApply: true` off —
	 * the caller should surface a one-time Notice explaining why. */
	autoApplyDisabled: boolean;
}

/**
 * Builds the in-memory settings from the RAW `loadData()` result. The
 * migration decision is made on the raw blob BEFORE defaults are merged in —
 * merging first would stamp `settingsVersion` onto legacy data and the
 * migration would never fire. Three cases:
 *  - `raw` null/undefined → fresh install: generic defaults, no migration.
 *  - `raw.settingsVersion` undefined → legacy (pre-v2) data: flip a live
 *    `organizeAutoApply: true` off, seed the organize destination exclusions
 *    that legacy vaults were mis-filing into, normalize string task models.
 *  - otherwise → current data: normalize task models defensively, no rewrite.
 */
export function loadSettingsFromRaw(raw: unknown): SettingsLoadResult {
	const base = structuredClone(DEFAULT_SETTINGS);
	if (raw === null || raw === undefined || typeof raw !== "object") {
		return { settings: base, migrated: false, autoApplyDisabled: false };
	}

	const rawObj = raw as Record<string, unknown>;
	const settings = Object.assign(base, rawObj) as FlintSettings;
	const legacyProvider = isProviderId(rawObj["activeProvider"])
		? rawObj["activeProvider"]
		: DEFAULT_SETTINGS.activeProvider;

	if (rawObj["settingsVersion"] === undefined) {
		const autoApplyDisabled = rawObj["organizeAutoApply"] === true;
		settings.organizeAutoApply = false;
		// Spencer-specific legacy seed: existing vaults were mis-filing clips
		// into these; fresh installs keep the generic default instead.
		settings.organizeExcludeFolders = ["02 Claude", "06 Templates"];
		settings.taskModels = migrateTaskModels(
			rawObj["taskModels"],
			legacyProvider,
		);
		settings.settingsVersion = SETTINGS_VERSION;
		return { settings, migrated: true, autoApplyDisabled };
	}

	// Current-version data: still normalize the task-model shape defensively
	// (a hand-edited or partially-synced data.json shouldn't crash resolve).
	settings.taskModels = migrateTaskModels(rawObj["taskModels"], legacyProvider);
	return { settings, migrated: false, autoApplyDisabled: false };
}

export const DEFAULT_SETTINGS: FlintSettings = {
	providers: {
		anthropic: { apiKey: "" },
		nim: { apiKey: "" },
		openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" },
		ollama: { baseUrl: "http://localhost:11434/v1" },
	},
	activeProvider: "anthropic",
	activeModel: "",
	ambition: "ambitious",
	useEmbeddings: true,
	embeddingProvider: "openai",
	embeddingModel: "text-embedding-3-small",
	embeddingDimensions: 512,
	excludeFolders: ["04 Dev Docs", "02 Claude/Config"],
	clippingsFolder: "03 Clippings",
	streamResponses: true,
	retrievalCount: 6,
	ingestEnabled: true,
	firecrawlApiKey: "",
	inboxNotes: ["00 Start/Inbox.md", "00 Start/Ideas.md"],
	projectsFolder: "01 Projects",
	autoTriage: false,
	autoTriageIntervalMinutes: 60,
	autoTriageAutoApply: false,
	captureFolder: "00 Start/Inbox",
	organizeEnabled: false,
	organizeAutoApply: false,
	organizeExcludeFolders: ["Templates"],
	filingGuideNote: "Flint Filing Guide.md",
	organizeMinConfidence: "high",
	agentMode: true,
	settingsVersion: SETTINGS_VERSION,
	dailyFolder: "00 Start/Daily",
	dailyAutoGenerate: false,
	imageProvider: "nim",
	imageModel: "stabilityai/stable-diffusion-3-medium",
	imageSize: "1024x1024",
	taskModels: {
		triage: { providerId: "", model: "" },
		organize: { providerId: "", model: "" },
		dashboard: { providerId: "", model: "" },
		htmlGenerate: { providerId: "", model: "" },
	},
};

export class FlintSettingTab extends PluginSettingTab {
	plugin: FlintPlugin;

	constructor(app: App, plugin: FlintPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Providers").setHeading();

		new Setting(containerEl)
			.setName("Anthropic API key")
			.setDesc("Used when the active provider is Anthropic.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-ant-...")
					.setValue(this.plugin.settings.providers.anthropic.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.providers.anthropic.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("NVIDIA NIM API key")
			.setDesc("Used when the active provider is NIM.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("nvapi-...")
					.setValue(this.plugin.settings.providers.nim.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.providers.nim.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("OpenAI API key")
			.setDesc("Used when the active provider is OpenAI.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.providers.openai.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.providers.openai.apiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("OpenAI base URL")
			.setDesc(
				"Must be https:// (http:// only allowed for localhost/127.0.0.1).",
			)
			.addText((text) => {
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.providers.openai.baseUrl)
					.onChange(async (value) => {
						try {
							validateBaseUrl(value);
						} catch (error) {
							new Notice(
								error instanceof Error ? error.message : String(error),
							);
							return;
						}
						this.plugin.settings.providers.openai.baseUrl = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Ollama base URL")
			.setDesc(
				"Used when the active provider is Ollama. Must be http://localhost or http://127.0.0.1 (or https://).",
			)
			.addText((text) => {
				text
					.setPlaceholder("http://localhost:11434/v1")
					.setValue(this.plugin.settings.providers.ollama.baseUrl)
					.onChange(async (value) => {
						try {
							validateBaseUrl(value);
						} catch (error) {
							new Notice(
								error instanceof Error ? error.message : String(error),
							);
							return;
						}
						this.plugin.settings.providers.ollama.baseUrl = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Model").setHeading();

		new Setting(containerEl)
			.setName("Active provider")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						anthropic: "Anthropic",
						nim: "NVIDIA NIM",
						openai: "OpenAI",
						ollama: "Ollama",
					})
					.setValue(this.plugin.settings.activeProvider)
					.onChange(async (value) => {
						this.plugin.settings.activeProvider = value as ProviderId;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		let currentModelOptions: string[] = [];

		const modelSetting = new Setting(containerEl)
			.setName("Active model")
			.setDesc("Model identifier sent to the active provider.")
			.addText((text) => {
				new ModelSuggest(
					this.app,
					text.inputEl,
					() => currentModelOptions,
					(value) => {
						text.setValue(value);
						this.plugin.settings.activeModel = value;
						void this.plugin.saveSettings();
					},
				);

				text
					.setPlaceholder("claude-sonnet-4-5")
					.setValue(this.plugin.settings.activeModel)
					.onChange(async (value) => {
						this.plugin.settings.activeModel = value;
						await this.plugin.saveSettings();
					});
			});

		const populateModelList = (force: boolean) => {
			fetchModels(this.plugin.settings.activeProvider, this.plugin.settings, {
				force,
			})
				.then((models) => {
					currentModelOptions = models;
					modelSetting.setDesc("Model identifier sent to the active provider.");
				})
				.catch(() => {
					currentModelOptions = [];
					modelSetting.setDesc(
						"Model identifier sent to the active provider. Couldn't load the model list — enter it manually.",
					);
				});
		};

		populateModelList(false);

		modelSetting.addExtraButton((button) => {
			button
				.setIcon("refresh-cw")
				.setTooltip("Refetch model list")
				.onClick(() => populateModelList(true));
		});

		new Setting(containerEl).setName("Task models").setHeading();
		containerEl.createEl("p", {
			text: "Optional per-task overrides. Leave the model empty to use the active model above. Each override can pin its own provider so a provider switch never strands a model id.",
			cls: "setting-item-description",
		});

		const addTaskModelSetting = (
			name: string,
			desc: string,
			task: TaskModelKey,
		) => {
			// Per-row model options, fetched for the row's OWN provider so the
			// suggest list always matches where the model id will actually run.
			let rowModelOptions: string[] = [];
			const rowProvider = (): ProviderId =>
				this.plugin.settings.taskModels[task].providerId ||
				this.plugin.settings.activeProvider;
			const fetchRowModels = () => {
				fetchModels(rowProvider(), this.plugin.settings, {})
					.then((models) => {
						rowModelOptions = models;
					})
					.catch(() => {
						rowModelOptions = [];
					});
			};
			fetchRowModels();

			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addDropdown((dropdown) => {
					dropdown
						.addOptions({
							"": "Same as active",
							anthropic: "Anthropic",
							nim: "NVIDIA NIM",
							openai: "OpenAI",
							ollama: "Ollama",
						})
						.setValue(this.plugin.settings.taskModels[task].providerId)
						.onChange(async (value) => {
							this.plugin.settings.taskModels[task].providerId =
								value === "" ? "" : (value as ProviderId);
							await this.plugin.saveSettings();
							fetchRowModels();
						});
				})
				.addText((text) => {
					new ModelSuggest(
						this.app,
						text.inputEl,
						() => rowModelOptions,
						(value) => {
							text.setValue(value);
							this.plugin.settings.taskModels[task].model = value;
							void this.plugin.saveSettings();
						},
					);

					text
						.setPlaceholder("same as chat")
						.setValue(this.plugin.settings.taskModels[task].model)
						.onChange(async (value) => {
							this.plugin.settings.taskModels[task].model = value;
							await this.plugin.saveSettings();
						});
				});
		};

		addTaskModelSetting(
			"Triage model",
			"Suggested: deepseek-ai/deepseek-v4-flash (fast, strong JSON/instruction following)",
			"triage",
		);
		addTaskModelSetting(
			"Auto-organize model",
			"Suggested: deepseek-ai/deepseek-v4-flash (fast, strong JSON/instruction following)",
			"organize",
		);
		addTaskModelSetting(
			"Daily dashboard model",
			"Suggested: google/gemma-3-12b-it (clean prose)",
			"dashboard",
		);
		addTaskModelSetting(
			"HTML generation model",
			"Leave empty to use the chat model (best quality)",
			"htmlGenerate",
		);

		new Setting(containerEl).setName("Vault indexing").setHeading();

		new Setting(containerEl)
			.setName("Use embeddings")
			.setDesc(
				"Master switch for semantic (meaning-based) search. Off falls back to keyword-only search everywhere.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.useEmbeddings)
					.onChange(async (value) => {
						this.plugin.settings.useEmbeddings = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Embedding provider")
			.setDesc(
				"Independent of the chat provider above — Anthropic has no embeddings API.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						openai: "OpenAI",
						nim: "NVIDIA NIM",
						ollama: "Ollama",
						none: "None (keyword-only)",
					})
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						this.plugin.settings.embeddingProvider =
							value as EmbeddingProviderId;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Embedding model")
			.setDesc(
				"e.g. text-embedding-3-small (OpenAI/NIM) or nomic-embed-text (Ollama).",
			)
			.addText((text) => {
				text
					.setPlaceholder("text-embedding-3-small")
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Embedding dimensions")
			.setDesc(
				"Matryoshka truncation via OpenAI's `dimensions` param. Ignored by Ollama, which returns its model's native size.",
			)
			.addText((text) => {
				text
					.setPlaceholder("512")
					.setValue(String(this.plugin.settings.embeddingDimensions))
					.onChange(async (value) => {
						const dims = Number.parseInt(value, 10);
						if (Number.isFinite(dims) && dims > 0) {
							this.plugin.settings.embeddingDimensions = dims;
							await this.plugin.saveSettings();
						}
					});
			});

		const embeddingStatusSetting = new Setting(containerEl).setName(
			"Embedding status",
		);
		const describeEmbeddingStatus = () => {
			const status = this.plugin.vaultIndex?.embeddingStatus();
			embeddingStatusSetting.setDesc(
				status
					? `${status.embedded}/${status.total} chunks embedded${status.pending > 0 ? ` (${status.pending} pending retry)` : ""}.`
					: "Not indexed yet.",
			);
		};
		describeEmbeddingStatus();
		embeddingStatusSetting.addExtraButton((button) => {
			button
				.setIcon("refresh-cw")
				.setTooltip("Refresh status")
				.onClick(() => describeEmbeddingStatus());
		});

		new Setting(containerEl)
			.setName("Rebuild embeddings")
			.setDesc(
				"Drops the cached vectors and re-embeds every chunk from scratch.",
			)
			.addButton((button) => {
				button.setButtonText("Rebuild").onClick(async () => {
					button.setDisabled(true).setButtonText("Rebuilding...");
					try {
						await this.plugin.rebuildEmbeddings();
						new Notice("Flint: embeddings rebuilt.");
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						new Notice(`Flint: rebuild failed — ${message}`);
					} finally {
						button.setDisabled(false).setButtonText("Rebuild");
						describeEmbeddingStatus();
					}
				});
			});

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Comma-separated list of vault folders to exclude from search and retrieval.",
			)
			.addText((text) => {
				text
					.setPlaceholder("04 Dev Docs")
					.setValue(this.plugin.settings.excludeFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludeFolders = value
							.split(",")
							.map((folder) => folder.trim())
							.filter((folder) => folder.length > 0);
						await this.plugin.saveSettings();
						await this.plugin.vaultIndex?.build();
					});
			});

		new Setting(containerEl).setName("Web clip ingest").setHeading();

		new Setting(containerEl)
			.setName("Enable clip ingest")
			.setDesc(
				"Tidy and stamp frontmatter on new clips landing in the clippings folder.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.ingestEnabled)
					.onChange(async (value) => {
						this.plugin.settings.ingestEnabled = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Clippings folder")
			.setDesc("Vault folder watched for new web clips.")
			.addText((text) => {
				text
					.setPlaceholder("03 Clippings")
					.setValue(this.plugin.settings.clippingsFolder)
					.onChange(async (value) => {
						this.plugin.settings.clippingsFolder = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Firecrawl API key")
			.setDesc(
				"Optional. Used as a fallback for 'Refetch clip source' when a direct fetch fails or returns thin content.",
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("fc-...")
					.setValue(this.plugin.settings.firecrawlApiKey)
					.onChange(async (value) => {
						this.plugin.settings.firecrawlApiKey = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Chat").setHeading();

		new Setting(containerEl)
			.setName("Stream responses")
			.setDesc(
				"Show tokens as they arrive where the provider supports it. Falls back to a full response otherwise.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.streamResponses)
					.onChange(async (value) => {
						this.plugin.settings.streamResponses = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Capture triage").setHeading();

		new Setting(containerEl)
			.setName("Inbox notes")
			.setDesc("Comma-separated vault paths to triage, in order.")
			.addText((text) => {
				text
					.setPlaceholder("00 Start/Inbox.md, 00 Start/Ideas.md")
					.setValue(this.plugin.settings.inboxNotes.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.inboxNotes = value
							.split(",")
							.map((path) => path.trim())
							.filter((path) => path.length > 0);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Projects folder")
			.setDesc("Vault folder scanned for project tracker notes.")
			.addText((text) => {
				text
					.setPlaceholder("01 Projects")
					.setValue(this.plugin.settings.projectsFolder)
					.onChange(async (value) => {
						this.plugin.settings.projectsFolder = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-triage")
			.setDesc(
				"Periodically checks the inbox and surfaces a Notice when items are ready.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoTriage)
					.onChange(async (value) => {
						this.plugin.settings.autoTriage = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-triage interval (minutes)")
			.addText((text) => {
				text
					.setPlaceholder("60")
					.setValue(String(this.plugin.settings.autoTriageIntervalMinutes))
					.onChange(async (value) => {
						const minutes = Number.parseInt(value, 10);
						if (Number.isFinite(minutes) && minutes > 0) {
							this.plugin.settings.autoTriageIntervalMinutes = minutes;
							await this.plugin.saveSettings();
						}
					});
			});

		new Setting(containerEl).setName("Content generation").setHeading();

		new Setting(containerEl)
			.setName("Image provider")
			.setDesc("Which endpoint 'Generate image from note' calls.")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({ nim: "NVIDIA NIM", openai: "OpenAI" })
					.setValue(this.plugin.settings.imageProvider)
					.onChange(async (value) => {
						this.plugin.settings.imageProvider = value as "nim" | "openai";
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Image model")
			.setDesc(
				"For NIM, the model's API path segment (e.g. stabilityai/stable-diffusion-3-medium). For OpenAI, the model name (e.g. gpt-image-1).",
			)
			.addText((text) => {
				text
					.setPlaceholder("stabilityai/stable-diffusion-3-medium")
					.setValue(this.plugin.settings.imageModel)
					.onChange(async (value) => {
						this.plugin.settings.imageModel = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Image size")
			.setDesc("e.g. 1024x1024. Mapped to an aspect ratio for NIM.")
			.addText((text) => {
				text
					.setPlaceholder("1024x1024")
					.setValue(this.plugin.settings.imageSize)
					.onChange(async (value) => {
						this.plugin.settings.imageSize = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-apply auto-triage")
			.setDesc(
				"DANGER: skips the review modal on scheduled runs and writes changes immediately. Off by default.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoTriageAutoApply)
					.onChange(async (value) => {
						this.plugin.settings.autoTriageAutoApply = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Auto-organize captures").setHeading();

		new Setting(containerEl)
			.setName("Enable auto-organize")
			.setDesc(
				"Suggests a title, tags, and destination folder (as frontmatter) for new notes landing in the capture folder.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.organizeEnabled)
					.onChange(async (value) => {
						this.plugin.settings.organizeEnabled = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Capture folder")
			.setDesc(
				"Vault folder watched for new captures. Idles silently if the folder doesn't exist.",
			)
			.addText((text) => {
				text
					.setPlaceholder("00 Start/Inbox")
					.setValue(this.plugin.settings.captureFolder)
					.onChange(async (value) => {
						this.plugin.settings.captureFolder = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-apply organize suggestions")
			.setDesc(
				"DANGER: renames/moves captures into the suggested destination immediately, with no review step. Off by default. Never applies on mobile.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.organizeAutoApply)
					.onChange(async (value) => {
						this.plugin.settings.organizeAutoApply = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Destination exclusions")
			.setDesc(
				"Comma-separated folders never offered as filing destinations (on top of the retrieval exclusions above).",
			)
			.addText((text) => {
				text
					.setPlaceholder("Templates")
					.setValue(this.plugin.settings.organizeExcludeFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.organizeExcludeFolders = value
							.split(",")
							.map((folder) => folder.trim())
							.filter((folder) => folder.length > 0);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Filing guide note")
			.setDesc(
				"Vault path of a note describing your folder conventions. Fed to the organize model as guidance; leave empty to skip.",
			)
			.addText((text) => {
				text
					.setPlaceholder("Flint Filing Guide.md")
					.setValue(this.plugin.settings.filingGuideNote)
					.onChange(async (value) => {
						this.plugin.settings.filingGuideNote = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Minimum filing confidence")
			.setDesc(
				"Destination suggestions below this self-reported confidence are dropped (the note just stays put).",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						high: "High (strict)",
						medium: "Medium",
						low: "Low (accept everything)",
					})
					.setValue(this.plugin.settings.organizeMinConfidence)
					.onChange(async (value) => {
						this.plugin.settings.organizeMinConfidence =
							value as OrganizeConfidence;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("Daily dashboard").setHeading();

		new Setting(containerEl)
			.setName("Daily folder")
			.setDesc(
				"Vault folder the daily dashboard note is written to, as YYYY-MM-DD.md.",
			)
			.addText((text) => {
				text
					.setPlaceholder("00 Start/Daily")
					.setValue(this.plugin.settings.dailyFolder)
					.onChange(async (value) => {
						this.plugin.settings.dailyFolder = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-generate daily dashboard")
			.setDesc(
				"Generates today's dashboard on startup if it doesn't exist yet. Never runs on mobile — the desktop/WSL client owns it.",
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.dailyAutoGenerate)
					.onChange(async (value) => {
						this.plugin.settings.dailyAutoGenerate = value;
						await this.plugin.saveSettings();
					});
			});
	}
}

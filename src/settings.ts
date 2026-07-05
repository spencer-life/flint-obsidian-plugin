import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FlintPlugin from "./main";
import { fetchModels } from "./providers";
import { validateBaseUrl } from "./providers/openai-compatible";
import { ModelSuggest } from "./ui/model-suggest";

export type ProviderId = "anthropic" | "nim" | "openai" | "ollama";
export type Ambition = "lean" | "balanced" | "ambitious";
export type EmbeddingProviderId = "openai" | "nim" | "ollama" | "none";

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
	dailyFolder: string;
	dailyAutoGenerate: boolean;
	imageProvider: "nim" | "openai";
	imageModel: string;
	imageSize: string;
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
	dailyFolder: "00 Start/Daily",
	dailyAutoGenerate: false,
	imageProvider: "nim",
	imageModel: "stabilityai/stable-diffusion-3-medium",
	imageSize: "1024x1024",
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

		containerEl.createEl("h2", { text: "Flint settings" });

		containerEl.createEl("h3", { text: "Providers" });

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

		containerEl.createEl("h3", { text: "Model" });

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

		containerEl.createEl("h3", { text: "Vault indexing" });

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

		containerEl.createEl("h3", { text: "Web clip ingest" });

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

		containerEl.createEl("h3", { text: "Chat" });

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

		containerEl.createEl("h3", { text: "Capture triage" });

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

		containerEl.createEl("h3", { text: "Content generation" });

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

		containerEl.createEl("h3", { text: "Auto-organize captures" });

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

		containerEl.createEl("h3", { text: "Daily dashboard" });

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

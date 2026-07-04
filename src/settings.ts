import { type App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FlintPlugin from "./main";
import { validateBaseUrl } from "./providers/openai-compatible";

export type ProviderId = "anthropic" | "nim" | "openai" | "ollama";
export type Ambition = "lean" | "balanced" | "ambitious";

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
					});
			});

		new Setting(containerEl)
			.setName("Active model")
			.setDesc("Model identifier sent to the active provider.")
			.addText((text) => {
				text
					.setPlaceholder("claude-sonnet-4-5")
					.setValue(this.plugin.settings.activeModel)
					.onChange(async (value) => {
						this.plugin.settings.activeModel = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h3", { text: "Vault indexing" });

		new Setting(containerEl)
			.setName("Use local embeddings")
			.setDesc(
				"Falls back to a lean keyword index where embeddings are too heavy (e.g. mobile).",
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
	}
}

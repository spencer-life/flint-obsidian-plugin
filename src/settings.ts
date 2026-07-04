import { type App, PluginSettingTab, Setting } from "obsidian";
import type FlintPlugin from "./main";

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
	excludeFolders: ["04 Dev Docs"],
	clippingsFolder: "03 Clippings",
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

		new Setting(containerEl).setName("OpenAI base URL").addText((text) => {
			text
				.setPlaceholder("https://api.openai.com/v1")
				.setValue(this.plugin.settings.providers.openai.baseUrl)
				.onChange(async (value) => {
					this.plugin.settings.providers.openai.baseUrl = value;
					await this.plugin.saveSettings();
				});
		});

		new Setting(containerEl)
			.setName("Ollama base URL")
			.setDesc("Used when the active provider is Ollama.")
			.addText((text) => {
				text
					.setPlaceholder("http://localhost:11434/v1")
					.setValue(this.plugin.settings.providers.ollama.baseUrl)
					.onChange(async (value) => {
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
					});
			});
	}
}

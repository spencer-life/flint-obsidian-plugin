import { Plugin, type WorkspaceLeaf } from "obsidian";
import {
	DEFAULT_SETTINGS,
	type FlintSettings,
	FlintSettingTab,
} from "./settings";
import { FlintView, VIEW_TYPE_FLINT } from "./view";

export default class FlintPlugin extends Plugin {
	settings: FlintSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_FLINT, (leaf) => new FlintView(leaf, this));

		this.addRibbonIcon("flame", "Open Flint", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-flint-panel",
			name: "Open Flint panel",
			callback: () => {
				void this.activateView();
			},
		});

		this.addSettingTab(new FlintSettingTab(this.app, this));
	}

	onunload(): void {
		// STUB: no teardown needed yet (registerView is auto-cleaned by Obsidian).
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;

		const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_FLINT);
		if (existingLeaves.length > 0) {
			const [leaf] = existingLeaves;
			if (leaf) {
				await workspace.revealLeaf(leaf);
			}
			return;
		}

		const leaf: WorkspaceLeaf | null = workspace.getRightLeaf(false);
		if (!leaf) {
			return;
		}

		await leaf.setViewState({ type: VIEW_TYPE_FLINT, active: true });
		await workspace.revealLeaf(leaf);
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

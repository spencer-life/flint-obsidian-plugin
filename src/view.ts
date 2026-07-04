import { ItemView, type WorkspaceLeaf } from "obsidian";
import type FlintPlugin from "./main";

export const VIEW_TYPE_FLINT = "flint-view";

export class FlintView extends ItemView {
	plugin: FlintPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: FlintPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FLINT;
	}

	getDisplayText(): string {
		return "Flint";
	}

	getIcon(): string {
		return "flame";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("flint-view");

		container.createEl("div", { cls: "flint-header", text: "Flint" });

		container.createEl("div", {
			cls: "flint-messages",
			text: "STUB: vault-aware chat coming soon.",
		});

		const inputRow = container.createEl("div", { cls: "flint-input-row" });
		const input = inputRow.createEl("input", {
			cls: "flint-input",
			attr: { type: "text", placeholder: "Ask your vault..." },
		});
		input.disabled = true;

		const sendButton = inputRow.createEl("button", {
			cls: "flint-send",
			text: "Send",
		});
		sendButton.disabled = true;
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}

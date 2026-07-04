import { ItemView, type WorkspaceLeaf } from "obsidian";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type FlintPlugin from "./main";
import { FlintContext } from "./react/context";
import { FlintPanel } from "./react/FlintPanel";

export const VIEW_TYPE_FLINT = "flint-view";

export class FlintView extends ItemView {
	plugin: FlintPlugin;
	root: Root | null = null;

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
		this.contentEl.addClass("flint-view");
		this.root = createRoot(this.contentEl);
		this.root.render(
			<StrictMode>
				<FlintContext.Provider value={{ app: this.app, plugin: this.plugin }}>
					<FlintPanel />
				</FlintContext.Provider>
			</StrictMode>,
		);
	}

	async onClose(): Promise<void> {
		this.root?.unmount();
	}
}

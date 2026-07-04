import {
	debounce,
	type Editor,
	Notice,
	Plugin,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { VaultIndex } from "./index/vault-index";
import {
	extractSourceUrl,
	splitFrontmatterBlock,
} from "./ingest/clip-processor";
import { fetchAndConvert } from "./ingest/refetch";
import { ClipWatcher } from "./ingest/watcher";
import {
	DEFAULT_SETTINGS,
	type FlintSettings,
	FlintSettingTab,
} from "./settings";
import { TriageService } from "./triage/triage";
import { FlintView, VIEW_TYPE_FLINT } from "./view";

export default class FlintPlugin extends Plugin {
	settings: FlintSettings = DEFAULT_SETTINGS;
	vaultIndex!: VaultIndex;
	clipWatcher!: ClipWatcher;
	triageService!: TriageService;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.vaultIndex = new VaultIndex(this.app, this.settings.excludeFolders);
		this.clipWatcher = new ClipWatcher(this);
		this.triageService = new TriageService(this);

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

		this.addCommand({
			id: "refetch-clip-source",
			name: "Refetch clip source",
			editorCallback: (editor, ctx) => {
				void this.refetchClipSource(editor, ctx.file);
			},
		});

		this.addCommand({
			id: "triage-inbox",
			name: "Triage inbox",
			callback: () => {
				void this.triageService.runManual();
			},
		});

		this.addSettingTab(new FlintSettingTab(this.app, this));

		this.app.workspace.onLayoutReady(() => {
			void this.vaultIndex.build();
			this.registerVaultIndexEvents();

			if (this.settings.ingestEnabled) {
				this.clipWatcher.register();
				void this.clipWatcher.scanBacklog();
			}

			if (this.settings.autoTriage) {
				this.registerInterval(
					window.setInterval(
						() => void this.triageService.runAuto(),
						this.settings.autoTriageIntervalMinutes * 60 * 1000,
					),
				);
			}
		});
	}

	/** "Refetch clip source" command: re-fetches the active note's `source`
	 * URL and replaces the body below frontmatter. On-demand only — never
	 * triggered automatically. */
	private async refetchClipSource(
		editor: Editor,
		file: TFile | null,
	): Promise<void> {
		if (!file) return;

		const cache = this.app.metadataCache.getFileCache(file);
		const sourceUrl = extractSourceUrl(cache?.frontmatter);
		if (!sourceUrl) {
			new Notice("Flint: this note has no `source` URL to refetch.");
			return;
		}

		new Notice("Flint: refetching clip source...");
		try {
			const result = await fetchAndConvert(
				sourceUrl,
				this.settings.firecrawlApiKey || undefined,
			);
			const { frontmatterBlock } = splitFrontmatterBlock(editor.getValue());
			editor.setValue(`${frontmatterBlock}${result.markdown}\n`);
			new Notice(`Flint: refetched via ${result.via}.`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Flint: refetch failed — ${message}`);
		}
	}

	/**
	 * Keeps the vault index fresh as notes change. Batches changed paths and
	 * flushes them through a single debounced pass so rapid successive edits
	 * (e.g. a sync pulling many files) don't trigger a re-index per file.
	 */
	private registerVaultIndexEvents(): void {
		const pendingPaths = new Set<string>();

		const flush = debounce(
			() => {
				const paths = Array.from(pendingPaths);
				pendingPaths.clear();
				for (const path of paths) {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile && file.extension === "md") {
						void this.vaultIndex.indexFile(file);
					} else {
						this.vaultIndex.removePath(path);
					}
				}
			},
			1500,
			true,
		);

		const schedule = (path: string) => {
			pendingPaths.add(path);
			flush();
		};

		this.registerEvent(
			this.app.vault.on("create", (file) => schedule(file.path)),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => schedule(file.path)),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) =>
				this.vaultIndex.removePath(file.path),
			),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.vaultIndex.removePath(oldPath);
				schedule(file.path);
			}),
		);
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
		this.vaultIndex?.setExcludeFolders(this.settings.excludeFolders);
	}
}

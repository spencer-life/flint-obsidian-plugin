import {
	debounce,
	type Editor,
	Notice,
	normalizePath,
	Plugin,
	requestUrl,
	TFile,
	type WorkspaceLeaf,
} from "obsidian";
import { buildDataUri, embedImageDataUri } from "./generate/compose";
import {
	buildHtmlPagePrompt,
	nextAvailablePath,
	stripReplyFences,
} from "./generate/html";
import {
	buildImageRequest,
	buildVisualPromptRequest,
	decodeBase64ToBytes,
	extractImageBase64,
	imageFileExtension,
	imageMimeType,
} from "./generate/image";
import { VaultIndex } from "./index/vault-index";
import {
	extractSourceUrl,
	splitFrontmatterBlock,
} from "./ingest/clip-processor";
import { fetchAndConvert } from "./ingest/refetch";
import { ClipWatcher } from "./ingest/watcher";
import { getProvider } from "./providers";
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

		this.addCommand({
			id: "generate-html-page-from-note",
			name: "Generate HTML page from note",
			editorCallback: (editor, ctx) => {
				void this.generateHtmlPageFromNote(editor, ctx.file);
			},
		});

		this.addCommand({
			id: "generate-image-from-note",
			name: "Generate image from note",
			editorCallback: (editor, ctx) => {
				void this.generateImageFromNote(editor, ctx.file);
			},
		});

		this.addCommand({
			id: "generate-page-and-image-from-note",
			name: "Generate page and image from note",
			editorCallback: (editor, ctx) => {
				void this.generatePageAndImageFromNote(editor, ctx.file);
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

	/** Vault path for `<note-basename>.<ext>` sitting next to `file`. */
	private siblingPath(file: TFile, ext: string): string {
		const parentPath = file.parent?.path;
		const raw = parentPath
			? `${parentPath}/${file.basename}.${ext}`
			: `${file.basename}.${ext}`;
		return normalizePath(raw);
	}

	private nextAvailableVaultPath(desiredPath: string): string {
		return nextAvailablePath(
			desiredPath,
			(path) => this.app.vault.getAbstractFileByPath(path) !== null,
		);
	}

	/** "Generate HTML page from note" command: sends the note to the active
	 * provider and saves the (defensively fence-stripped) HTML reply next to
	 * the note, never overwriting an existing file. */
	private async generateHtmlPageFromNote(
		editor: Editor,
		file: TFile | null,
	): Promise<void> {
		if (!file) return;

		new Notice("Flint: generating HTML page...");
		try {
			const html = await this.generateHtmlPage(file, editor.getValue());
			const targetPath = this.nextAvailableVaultPath(
				this.siblingPath(file, "html"),
			);
			await this.app.vault.create(targetPath, html);
			new Notice(`Flint: generated HTML page at ${targetPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Flint: HTML generation failed — ${message}`);
		}
	}

	/** Asks the active provider to turn `content` into a self-contained HTML
	 * document, defensively stripping any Markdown fencing in the reply. */
	private async generateHtmlPage(
		file: TFile,
		content: string,
	): Promise<string> {
		const provider = getProvider(this.settings);
		const reply = await provider.chat(
			buildHtmlPagePrompt(file.basename, content),
			{ model: this.settings.activeModel },
		);
		return stripReplyFences(reply);
	}

	/** Generates a base64-encoded image for `file`/`content`: one provider
	 * chat() call for a short visual prompt, then one image-endpoint call. */
	private async generateImageAsset(
		file: TFile,
		content: string,
	): Promise<string> {
		const provider = getProvider(this.settings);
		const visualPrompt = await provider.chat(
			buildVisualPromptRequest(file.basename, content),
			{ model: this.settings.activeModel },
		);

		const apiKey =
			this.settings.imageProvider === "nim"
				? this.settings.providers.nim.apiKey
				: this.settings.providers.openai.apiKey;

		const { url, headers, body } = buildImageRequest({
			provider: this.settings.imageProvider,
			apiKey,
			model: this.settings.imageModel,
			prompt: visualPrompt.trim(),
			size: this.settings.imageSize,
		});

		const response = await requestUrl({ url, method: "POST", headers, body });
		return extractImageBase64(this.settings.imageProvider, response.json);
	}

	/** "Generate image from note" command: derives a visual prompt from the
	 * note, calls the configured image endpoint, and saves the decoded PNG
	 * next to the note, never overwriting an existing file. */
	private async generateImageFromNote(
		editor: Editor,
		file: TFile | null,
	): Promise<void> {
		if (!file) return;

		new Notice("Flint: generating image...");
		try {
			const base64 = await this.generateImageAsset(file, editor.getValue());
			const bytes = decodeBase64ToBytes(base64);
			const targetPath = this.nextAvailableVaultPath(
				this.siblingPath(file, imageFileExtension(this.settings.imageProvider)),
			);
			await this.app.vault.createBinary(
				targetPath,
				bytes.buffer as ArrayBuffer,
			);
			new Notice(`Flint: generated image at ${targetPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Flint: image generation failed — ${message}`);
		}
	}

	/** "Generate page and image from note" command: pure composition of the
	 * HTML-page and image flows above, embedding the generated image as a
	 * data URI at the top of the generated HTML. */
	private async generatePageAndImageFromNote(
		editor: Editor,
		file: TFile | null,
	): Promise<void> {
		if (!file) return;

		new Notice("Flint: generating page and image...");
		try {
			const content = editor.getValue();
			const base64 = await this.generateImageAsset(file, content);
			const html = await this.generateHtmlPage(file, content);
			const embedded = embedImageDataUri(
				html,
				buildDataUri(imageMimeType(this.settings.imageProvider), base64),
			);

			const htmlPath = this.nextAvailableVaultPath(
				this.siblingPath(file, "html"),
			);
			await this.app.vault.create(htmlPath, embedded);

			const bytes = decodeBase64ToBytes(base64);
			const pngPath = this.nextAvailableVaultPath(
				this.siblingPath(file, imageFileExtension(this.settings.imageProvider)),
			);
			await this.app.vault.createBinary(pngPath, bytes.buffer as ArrayBuffer);

			new Notice(`Flint: generated ${htmlPath} and ${pngPath}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Flint: page/image generation failed — ${message}`);
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

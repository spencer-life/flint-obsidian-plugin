import { debounce, normalizePath, TFile } from "obsidian";
import type FlintPlugin from "../main";
import {
	extractFirstHeading,
	extractSourceUrl,
	isClipProcessed,
	isWithinFolder,
	needsProcessing,
	stampClipFrontmatter,
	suggestFilename,
} from "./clip-processor";

const DEBOUNCE_MS = 1200;

/**
 * Watches the clippings folder for new/changed clips, tidies + stamps their
 * frontmatter (idempotent via the `flint: processed` marker), and normalizes
 * egregious filenames. Register via `register()` inside `onLayoutReady`, then
 * run `scanBacklog()` once to catch clips that synced while Obsidian was
 * closed.
 */
export class ClipWatcher {
	constructor(private plugin: FlintPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	private clippingsFolder(): string {
		return normalizePath(this.plugin.settings.clippingsFolder);
	}

	/** Wires vault events. Must be called from inside `onLayoutReady`. */
	register(): void {
		const pendingPaths = new Set<string>();

		const flush = debounce(
			() => {
				const paths = Array.from(pendingPaths);
				pendingPaths.clear();
				for (const path of paths) {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile && file.extension === "md") {
						void this.processClip(file);
					}
				}
			},
			DEBOUNCE_MS,
			true,
		);

		const schedule = (path: string) => {
			if (!isWithinFolder(path, this.clippingsFolder())) return;
			pendingPaths.add(path);
			flush();
		};

		// Only `create` is watched for ingestion: a `modify` of an already
		// processed clip shouldn't re-trigger, and a `rename`/move must not
		// reprocess a clip either — the frontmatter marker plus omitting
		// `rename` here both guard against that.
		this.plugin.registerEvent(
			this.app.vault.on("create", (file) => schedule(file.path)),
		);
	}

	/** Scans the clippings folder for files lacking the processed marker. */
	async scanBacklog(): Promise<void> {
		const folder = this.clippingsFolder();
		const files = this.app.vault.getMarkdownFiles();

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (needsProcessing(file.path, folder, cache?.frontmatter)) {
				await this.processClip(file);
			}
		}
	}

	/** Tidies + stamps a single clip file. No-op if already processed. */
	async processClip(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (isClipProcessed(cache?.frontmatter)) return;

		const sourceUrl = extractSourceUrl(cache?.frontmatter);

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			stampClipFrontmatter(frontmatter, { now: new Date(), sourceUrl });
		});

		await this.maybeRename(file);
	}

	private async maybeRename(file: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(file);
		const cache = this.app.metadataCache.getFileCache(file);
		const heading =
			extractFirstHeading(content) ??
			(typeof cache?.frontmatter?.["title"] === "string"
				? (cache.frontmatter["title"] as string)
				: undefined);

		const newBasename = suggestFilename(file.basename, heading);
		if (!newBasename) return;

		const parentPath = file.parent?.path ?? this.clippingsFolder();
		const newPath = normalizePath(`${parentPath}/${newBasename}.md`);
		if (newPath === file.path) return;
		if (this.app.vault.getAbstractFileByPath(newPath)) return;

		await this.app.fileManager.renameFile(file, newPath);
	}
}

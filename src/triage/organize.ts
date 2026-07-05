import {
	debounce,
	Modal,
	Notice,
	normalizePath,
	Platform,
	TFile,
	TFolder,
} from "obsidian";
import { nextAvailablePath } from "../generate/html";
import { isWithinFolder } from "../ingest/clip-processor";
import type FlintPlugin from "../main";
import { getProvider } from "../providers";
import { resolveTaskModel } from "../settings";
import {
	type OrganizeSuggestion,
	parseOrganizeResponse,
} from "./organize-parse";
import { buildOrganizePrompt, type SimilarNote } from "./organize-prompt";

const DEBOUNCE_MS = 1200;

/** How much of a capture's content to feed the semantic-similarity lookup —
 * capped so a huge capture doesn't blow up the retrieval query. */
const SIMILARITY_QUERY_CHARS = 2000;

/** How many similar notes to surface as routing evidence. */
const SIMILAR_NOTE_COUNT = 3;

/** True when a note's frontmatter already carries the Flint organize marker
 * (the idempotency guard — mirrors `flint: processed` for clips). */
export function isOrganized(
	frontmatter: Record<string, unknown> | null | undefined,
): boolean {
	return frontmatter?.["flint-organized"] === true;
}

interface OrganizeReviewItem {
	file: TFile;
	title?: string;
	tags: string[];
	destination?: string;
}

/**
 * Watches the configured capture folder for new notes, asks the active
 * provider to suggest a title/tags/destination, and writes the suggestions
 * as frontmatter (never moves anything by itself unless `organizeAutoApply`
 * is on). Idempotent via the `flint-organized: true` marker. Mirrors
 * `ClipWatcher`'s create-event + backlog-scan pattern.
 */
export class OrganizeService {
	constructor(private plugin: FlintPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	private captureFolder(): string {
		return normalizePath(this.plugin.settings.captureFolder);
	}

	/** Wires vault events. Must be called from inside `onLayoutReady`, and
	 * only when `organizeEnabled` is on. */
	register(): void {
		const pendingPaths = new Set<string>();

		const flush = debounce(
			() => {
				const paths = Array.from(pendingPaths);
				pendingPaths.clear();
				for (const path of paths) {
					const file = this.app.vault.getAbstractFileByPath(path);
					if (file instanceof TFile && file.extension === "md") {
						void this.processCapture(file);
					}
				}
			},
			DEBOUNCE_MS,
			true,
		);

		const schedule = (path: string) => {
			if (!isWithinFolder(path, this.captureFolder())) return;
			pendingPaths.add(path);
			flush();
		};

		// Only `create` is watched: a `modify` of an already-organized capture
		// shouldn't re-trigger, and the frontmatter marker guards a re-scan
		// from reprocessing it either way.
		this.plugin.registerEvent(
			this.app.vault.on("create", (file) => schedule(file.path)),
		);
	}

	/** Scans the capture folder for notes lacking the organize marker. If the
	 * capture folder doesn't exist (e.g. it's still just a note, not a
	 * folder), this simply finds nothing and idles silently. */
	async scanBacklog(): Promise<void> {
		const folder = this.captureFolder();
		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => isWithinFolder(file.path, folder));

		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (isOrganized(cache?.frontmatter)) continue;
			await this.processCapture(file);
		}
	}

	/**
	 * Builds the allowlist of real, existing vault folder paths a destination
	 * suggestion may exactly match. Computed fresh from the live vault tree
	 * every time (never cached, never hand-authored) so an LLM-emitted path
	 * can never be trusted directly — only membership in this list matters.
	 */
	private computeDestinationAllowlist(): string[] {
		const excluded = this.plugin.settings.excludeFolders;
		const capture = this.captureFolder();
		const folders: string[] = [];

		const isExcluded = (path: string) =>
			excluded.some(
				(folder) => path === folder || path.startsWith(`${folder}/`),
			);

		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (!(child instanceof TFolder)) continue;
				if (child.path !== capture && !isExcluded(child.path)) {
					folders.push(child.path);
				}
				walk(child);
			}
		};

		walk(this.app.vault.getRoot());
		return folders.sort();
	}

	/** Top-k semantically similar notes to feed as routing evidence, via the
	 * (async) hybrid retrieval built in Phase 1. Any failure (no embeddings,
	 * offline, provider off) degrades to an empty list — the prompt still
	 * works with just the folder list, same as `buildTriagePrompt`. */
	private async similarNotes(content: string): Promise<SimilarNote[]> {
		try {
			const chunks = await this.plugin.vaultIndex.retrieve(
				content.slice(0, SIMILARITY_QUERY_CHARS),
				SIMILAR_NOTE_COUNT,
			);
			const seen = new Set<string>();
			const notes: SimilarNote[] = [];
			for (const chunk of chunks) {
				if (seen.has(chunk.path)) continue;
				seen.add(chunk.path);
				notes.push({ path: chunk.path });
			}
			return notes;
		} catch {
			return [];
		}
	}

	/** Suggests + stamps a single capture. No-op if already organized. Never
	 * writes anything if the LLM call/parse fails (throw-don't-write). */
	async processCapture(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (isOrganized(cache?.frontmatter)) return;

		const content = await this.app.vault.cachedRead(file);
		const allowlist = this.computeDestinationAllowlist();
		const similar = await this.similarNotes(content);
		const messages = buildOrganizePrompt(content, allowlist, similar);

		let suggestion: OrganizeSuggestion;
		try {
			const provider = getProvider(this.plugin.settings);
			const raw = await provider.chat(messages, {
				model: resolveTaskModel(this.plugin.settings, "organize"),
			});
			suggestion = parseOrganizeResponse(raw, allowlist);
		} catch {
			// Bad/unparseable LLM response — write nothing, leave the capture
			// untouched so a later scan can retry.
			return;
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter["flint-organized"] = true;
			frontmatter["flint-suggest-title"] = suggestion.title;
			frontmatter["flint-suggest-tags"] = suggestion.tags;
			if (suggestion.destination) {
				frontmatter["flint-suggest-dest"] = suggestion.destination;
			}
		});

		if (this.plugin.settings.organizeAutoApply && !Platform.isMobile) {
			await this.applySuggestions(file);
		}
	}

	/** Vault path for `desiredPath`, or the next " (2)", " (3)", ... variant if
	 * something else already sits there. Never treats `file`'s own current
	 * path as a collision with itself. */
	private nextAvailableVaultPath(
		desiredPath: string,
		currentPath: string,
	): string {
		if (desiredPath === currentPath) return desiredPath;
		return nextAvailablePath(
			desiredPath,
			(path) =>
				path !== currentPath &&
				this.app.vault.getAbstractFileByPath(path) !== null,
		);
	}

	/**
	 * Applies a capture's already-written suggestions: renames the file into
	 * the validated destination folder (Obsidian's `renameFile` keeps
	 * backlinks intact) using the sanitized suggested title as the new
	 * basename, resolving any collision via `nextAvailablePath`. No-op if the
	 * capture was never organized.
	 */
	async applySuggestions(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (!isOrganized(frontmatter)) return;

		const title =
			typeof frontmatter?.["flint-suggest-title"] === "string"
				? (frontmatter["flint-suggest-title"] as string)
				: undefined;
		const destination =
			typeof frontmatter?.["flint-suggest-dest"] === "string"
				? (frontmatter["flint-suggest-dest"] as string)
				: undefined;

		const parentPath = destination ?? file.parent?.path ?? "";
		const basename =
			title && title.trim().length > 0 ? title.trim() : file.basename;
		const desiredPath = normalizePath(
			parentPath.length > 0 ? `${parentPath}/${basename}.md` : `${basename}.md`,
		);

		const targetPath = this.nextAvailableVaultPath(desiredPath, file.path);
		if (targetPath !== file.path) {
			await this.app.fileManager.renameFile(file, targetPath);
		}
	}

	/** "Apply organize suggestions" command (active note): explicit,
	 * single-file confirmation — the user invoking this command on a note
	 * they've reviewed IS the confirmation step. */
	async runManualApply(file: TFile): Promise<void> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!isOrganized(cache?.frontmatter)) {
			new Notice("Flint: this note has no organize suggestions yet.");
			return;
		}

		await this.applySuggestions(file);
		new Notice(`Flint: applied organize suggestions to ${file.basename}.`);
	}

	/** Bulk review command: lists every organized-but-unapplied capture in a
	 * confirmation modal before applying any of them. */
	async runBulkReview(): Promise<void> {
		const folder = this.captureFolder();
		const items: OrganizeReviewItem[] = [];

		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!isWithinFolder(file.path, folder)) continue;
			const cache = this.app.metadataCache.getFileCache(file);
			const frontmatter = cache?.frontmatter;
			if (!isOrganized(frontmatter)) continue;

			items.push({
				file,
				title:
					typeof frontmatter?.["flint-suggest-title"] === "string"
						? (frontmatter["flint-suggest-title"] as string)
						: undefined,
				tags: Array.isArray(frontmatter?.["flint-suggest-tags"])
					? (frontmatter["flint-suggest-tags"] as string[])
					: [],
				destination:
					typeof frontmatter?.["flint-suggest-dest"] === "string"
						? (frontmatter["flint-suggest-dest"] as string)
						: undefined,
			});
		}

		if (items.length === 0) {
			new Notice("Flint: no organize suggestions to review.");
			return;
		}

		new OrganizeReviewModal(this.plugin, items, () => {
			void (async () => {
				for (const item of items) {
					await this.applySuggestions(item.file);
				}
				new Notice(`Flint: applied ${items.length} organize suggestion(s).`);
			})();
		}).open();
	}
}

/** Dry-run confirmation modal: lists every pending organize suggestion
 * before anything is moved. Shape mirrors triage's review modal. */
class OrganizeReviewModal extends Modal {
	constructor(
		plugin: FlintPlugin,
		private items: OrganizeReviewItem[],
		private onConfirm: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Flint: review organize suggestions" });

		const list = contentEl.createEl("ul");
		for (const item of this.items) {
			const li = list.createEl("li");
			li.createEl("strong", { text: item.file.basename });
			if (item.title) li.createSpan({ text: ` → ${item.title}` });
			if (item.destination) li.createSpan({ text: ` (${item.destination})` });
			if (item.tags.length > 0) {
				li.createEl("div", { text: item.tags.join(", ") });
			}
		}

		const buttons = contentEl.createDiv();
		const confirmButton = buttons.createEl("button", { text: "Apply all" });
		confirmButton.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});

		const cancelButton = buttons.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

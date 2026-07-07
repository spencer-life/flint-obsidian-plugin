import {
	debounce,
	Modal,
	Notice,
	normalizePath,
	Platform,
	TFile,
} from "obsidian";
import { computeDestinationAllowlist } from "../agent/vault-tree";
import { nextAvailablePath } from "../generate/html";
import { isWithinFolder } from "../ingest/clip-processor";
import { appendFlintLog } from "../log/flint-log";
import type FlintPlugin from "../main";
import { chatWithTaskModel } from "../providers";
import {
	buildOrganizeLogLine,
	meetsOrganizeConfidence,
	type OrganizeSuggestion,
	parseOrganizeResponse,
	resolveOrganizeDestination,
} from "./organize-parse";
import { buildOrganizePrompt, type SimilarNote } from "./organize-prompt";

const DEBOUNCE_MS = 1200;

/** How much of a capture's content to feed the semantic-similarity lookup —
 * capped so a huge capture doesn't blow up the retrieval query. */
const SIMILARITY_QUERY_CHARS = 2000;

/** How much of the filing-guide note reaches the prompt. */
const FILING_GUIDE_CHARS = 2000;

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

	/** Live destination allowlist via the shared vault-tree helper: retrieval
	 * exclusions ∪ organize-destination exclusions, plus the capture folder
	 * and its subfolders. */
	private computeDestinationAllowlist(): string[] {
		return computeDestinationAllowlist(this.app.vault.getRoot(), {
			excludedFolders: [
				...this.plugin.settings.excludeFolders,
				...this.plugin.settings.organizeExcludeFolders,
			],
			captureFolder: this.captureFolder(),
		});
	}

	/** First ~2000 chars of the configured filing-guide note, or undefined
	 * when unset/missing/unreadable — the prompt degrades cleanly without it. */
	private async readFilingGuide(): Promise<string | undefined> {
		const configured = this.plugin.settings.filingGuideNote.trim();
		if (configured.length === 0) return undefined;
		const file = this.app.vault.getAbstractFileByPath(
			normalizePath(configured),
		);
		if (!(file instanceof TFile)) return undefined;
		try {
			const text = await this.app.vault.cachedRead(file);
			const trimmed = text.slice(0, FILING_GUIDE_CHARS).trim();
			return trimmed.length > 0 ? trimmed : undefined;
		} catch {
			return undefined;
		}
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
		const guide = await this.readFilingGuide();
		const messages = buildOrganizePrompt(content, allowlist, similar, guide);

		let suggestion: OrganizeSuggestion;
		try {
			const raw = await chatWithTaskModel(
				this.plugin.settings,
				"organize",
				messages,
			);
			suggestion = parseOrganizeResponse(raw, allowlist);
		} catch {
			// Bad/unparseable LLM response — write nothing, leave the capture
			// untouched so a later scan can retry.
			return;
		}

		// Confidence gate: a below-threshold destination is dropped ENTIRELY —
		// never written as `flint-suggest-dest` — because the apply path
		// re-reads frontmatter later and would happily file a low-confidence
		// guess it finds there. Title/tags still stand.
		const destination = meetsOrganizeConfidence(
			suggestion.confidence,
			this.plugin.settings.organizeMinConfidence,
		)
			? suggestion.destination
			: null;

		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			frontmatter["flint-organized"] = true;
			frontmatter["flint-suggest-title"] = suggestion.title;
			frontmatter["flint-suggest-tags"] = suggestion.tags;
			if (destination) {
				frontmatter["flint-suggest-dest"] = destination;
			}
		});

		if (this.plugin.settings.organizeAutoApply && !Platform.isMobile) {
			// Apply from the suggestion in hand — the metadata cache won't have
			// re-indexed the frontmatter written just above yet, so the
			// cache-reading path would silently see "not organized" and no-op.
			await this.applyResolved(file, suggestion.title, destination);
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
		const rawDestination =
			typeof frontmatter?.["flint-suggest-dest"] === "string"
				? (frontmatter["flint-suggest-dest"] as string)
				: undefined;

		// Re-validate against the LIVE allowlist: frontmatter is editable by
		// anything (user, other plugins, a clip that arrives with pre-seeded
		// suggest fields), so a stored destination is never trusted on read.
		const destination = rawDestination
			? resolveOrganizeDestination(
					rawDestination,
					this.computeDestinationAllowlist(),
				)
			: null;

		await this.applyResolved(file, title, destination);
	}

	/** Shared move/rename core: files `file` into `destination` (already
	 * allowlist-validated upstream) under the sanitized `title` basename.
	 * Takes the values directly so the fresh-suggestion path never depends on
	 * the (possibly stale) metadata cache. */
	private async applyResolved(
		file: TFile,
		title: string | undefined,
		destination: string | null,
	): Promise<void> {
		const parentPath = destination ?? file.parent?.path ?? "";
		const basename =
			title && title.trim().length > 0 ? title.trim() : file.basename;
		const desiredPath = normalizePath(
			parentPath.length > 0 ? `${parentPath}/${basename}.md` : `${basename}.md`,
		);

		const targetPath = this.nextAvailableVaultPath(desiredPath, file.path);
		if (targetPath !== file.path) {
			const oldPath = file.path;
			await this.app.fileManager.renameFile(file, targetPath);
			await this.appendMoveLog(oldPath, targetPath);
		}
	}

	/** Appends one line to the vault-root activity log for an applied move
	 * via the shared best-effort log helper. */
	private async appendMoveLog(oldPath: string, newPath: string): Promise<void> {
		const timestamp = window.moment().format("YYYY-MM-DD HH:mm");
		await appendFlintLog(
			this.app.vault,
			buildOrganizeLogLine(oldPath, newPath, timestamp),
		);
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

		new OrganizeReviewModal(this.plugin, items, (selected) => {
			void (async () => {
				for (const item of selected) {
					await this.applySuggestions(item.file);
				}
				new Notice(`Flint: applied ${selected.length} organize suggestion(s).`);
			})();
		}).open();
	}
}

/** Per-item confirmation modal: every pending suggestion gets its own
 * checkbox (on by default), and only the checked subset is applied. Rows
 * without a destination are dimmed — applying them only renames in place. */
class OrganizeReviewModal extends Modal {
	private selected: Set<OrganizeReviewItem>;

	constructor(
		plugin: FlintPlugin,
		private items: OrganizeReviewItem[],
		private onConfirm: (selected: OrganizeReviewItem[]) => void,
	) {
		super(plugin.app);
		this.selected = new Set(items);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Flint: review organize suggestions" });

		let confirmButton: HTMLButtonElement;
		const refreshConfirmLabel = () => {
			confirmButton.textContent = `Apply selected (${this.selected.size})`;
			confirmButton.disabled = this.selected.size === 0;
		};

		const list = contentEl.createEl("ul", { cls: "flint-review-list" });
		for (const item of this.items) {
			const li = list.createEl("li");
			if (!item.destination) li.addClass("flint-review-stays");

			const label = li.createEl("label");
			const checkbox = label.createEl("input", {
				type: "checkbox",
			}) as HTMLInputElement;
			checkbox.checked = true;
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) this.selected.add(item);
				else this.selected.delete(item);
				refreshConfirmLabel();
			});

			label.createEl("strong", { text: ` ${item.file.basename}` });
			if (item.title) label.createSpan({ text: ` → ${item.title}` });
			label.createSpan({
				text: item.destination
					? ` (${item.destination})`
					: " (stays in capture folder)",
			});
			if (item.tags.length > 0) {
				li.createEl("div", { text: item.tags.join(", ") });
			}
		}

		const buttons = contentEl.createDiv({ cls: "flint-review-buttons" });
		confirmButton = buttons.createEl("button", { text: "Apply selected" });
		confirmButton.addEventListener("click", () => {
			this.onConfirm(Array.from(this.selected));
			this.close();
		});
		refreshConfirmLabel();

		const cancelButton = buttons.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

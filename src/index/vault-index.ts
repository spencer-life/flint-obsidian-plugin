import MiniSearch from "minisearch";
import type { App, TFile } from "obsidian";
import { chunkNote, type VaultChunk } from "./chunk";

function isExcluded(path: string, excludeFolders: string[]): boolean {
	return excludeFolders.some(
		(folder) => path === folder || path.startsWith(`${folder}/`),
	);
}

/**
 * Vault-wide search index over markdown chunks, built with MiniSearch. Excludes
 * configured folders (e.g. "04 Dev Docs"). Supports incremental per-file
 * updates so the plugin can keep the index fresh as the vault changes.
 */
export class VaultIndex {
	private mini: MiniSearch<VaultChunk>;
	private pathToIds = new Map<string, string[]>();

	constructor(
		private app: App,
		private excludeFolders: string[],
	) {
		this.mini = new MiniSearch<VaultChunk>({
			idField: "id",
			fields: ["heading", "text"],
			storeFields: ["path", "heading", "text"],
		});
	}

	setExcludeFolders(excludeFolders: string[]): void {
		this.excludeFolders = excludeFolders;
	}

	/** Full rebuild over every markdown file not under an excluded folder. */
	async build(): Promise<void> {
		this.mini.removeAll();
		this.pathToIds.clear();

		const files = this.app.vault
			.getMarkdownFiles()
			.filter((file) => !isExcluded(file.path, this.excludeFolders));

		for (const file of files) {
			await this.indexFile(file);
		}
	}

	/** Re-index a single file (used for incremental create/modify updates). */
	async indexFile(file: TFile): Promise<void> {
		this.removePath(file.path);

		if (isExcluded(file.path, this.excludeFolders)) return;

		const content = await this.app.vault.cachedRead(file);
		const chunks = chunkNote(file.path, content);
		if (chunks.length === 0) return;

		this.mini.addAll(chunks);
		this.pathToIds.set(
			file.path,
			chunks.map((chunk) => chunk.id),
		);
	}

	/** Drop a file's chunks from the index (used for delete/rename/exclude updates). */
	removePath(path: string): void {
		const ids = this.pathToIds.get(path);
		if (!ids) return;
		for (const id of ids) {
			if (this.mini.has(id)) this.mini.discard(id);
		}
		this.pathToIds.delete(path);
	}

	/** Top-k most relevant chunks for a query. */
	retrieve(query: string, k = 6): VaultChunk[] {
		const trimmed = query.trim();
		if (trimmed.length === 0) return [];

		const results = this.mini.search(trimmed, {
			prefix: true,
			fuzzy: 0.2,
			boost: { heading: 2 },
		});

		return results.slice(0, k).map((result) => ({
			id: String(result.id),
			path: result.path as string,
			heading: result.heading as string,
			text: result.text as string,
		}));
	}
}

export type { VaultChunk } from "./chunk";
export { chunkNote } from "./chunk";

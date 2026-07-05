import MiniSearch from "minisearch";
import type { App, TFile } from "obsidian";
import {
	getEmbeddingProvider,
	resolveEmbeddingDimensions,
} from "../providers/embeddings";
import type { FlintSettings } from "../settings";
import { chunkNote, type VaultChunk } from "./chunk";
import {
	deserializeStore,
	type EmbeddingStoreHeader,
	serializeStore,
} from "./embedding-store";
import { fuseRRF } from "./hybrid";
import { SemanticIndex } from "./semantic-index";

/** How many candidates to pull from each ranking before RRF fusion — more
 * than the final `k` so fusion has real overlap to work with. */
const CANDIDATE_MULTIPLIER = 2;
const MIN_CANDIDATES = 20;

function isExcluded(path: string, excludeFolders: string[]): boolean {
	return excludeFolders.some(
		(folder) => path === folder || path.startsWith(`${folder}/`),
	);
}

/**
 * Vault-wide retrieval facade fanning out to a MiniSearch keyword index and
 * an in-memory semantic (vector) index, fused via Reciprocal Rank Fusion.
 * Excludes configured folders (e.g. "04 Dev Docs"). Supports incremental
 * per-file updates so the plugin can keep both indexes fresh as the vault
 * changes. Embedding is entirely best-effort: any failure (no key, offline,
 * rate limited) degrades silently to the keyword-only path.
 */
export class VaultIndex {
	private mini: MiniSearch<VaultChunk>;
	private pathToIds = new Map<string, string[]>();
	private semantic = new SemanticIndex();

	constructor(
		private app: App,
		private excludeFolders: string[],
		private settings: FlintSettings,
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

	private embeddingHeader(): EmbeddingStoreHeader {
		return {
			provider: this.settings.embeddingProvider,
			model: this.settings.embeddingModel,
			dims: resolveEmbeddingDimensions(this.settings),
		};
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

		if (this.settings.useEmbeddings) {
			const provider = getEmbeddingProvider(this.settings);
			await this.semantic.upsertFile(file.path, chunks, provider, {
				model: this.settings.embeddingModel,
				dimensions: resolveEmbeddingDimensions(this.settings),
			});
		} else {
			this.semantic.removePath(file.path);
		}
	}

	/** Drop a file's chunks from both indexes (used for delete/rename/exclude updates). */
	removePath(path: string): void {
		const ids = this.pathToIds.get(path);
		if (ids) {
			for (const id of ids) {
				if (this.mini.has(id)) this.mini.discard(id);
			}
			this.pathToIds.delete(path);
		}
		this.semantic.removePath(path);
	}

	/**
	 * Top-k most relevant chunks for a query, fused from keyword and vector
	 * rankings. Async because query embedding is a network call; any failure
	 * there (offline, 429, no key, provider off) degrades silently to the
	 * keyword-only path rather than blocking chat.
	 */
	async retrieve(query: string, k = 6): Promise<VaultChunk[]> {
		const trimmed = query.trim();
		if (trimmed.length === 0) return [];

		const candidates = Math.max(k * CANDIDATE_MULTIPLIER, MIN_CANDIDATES);
		const keywordResults = this.mini
			.search(trimmed, { prefix: true, fuzzy: 0.2, boost: { heading: 2 } })
			.slice(0, candidates)
			.map((result) => ({
				id: String(result.id),
				path: result.path as string,
				heading: result.heading as string,
				text: result.text as string,
			}));

		if (!this.settings.useEmbeddings) {
			return keywordResults.slice(0, k);
		}

		const provider = getEmbeddingProvider(this.settings);
		if (!provider) {
			return keywordResults.slice(0, k);
		}

		let vectorResults: VaultChunk[] = [];
		try {
			const [queryVector] = await provider.embed([trimmed], {
				model: this.settings.embeddingModel,
				dimensions: resolveEmbeddingDimensions(this.settings),
			});
			if (queryVector) {
				vectorResults = this.semantic.retrieve(queryVector, candidates);
			}
		} catch {
			return keywordResults.slice(0, k);
		}

		return fuseRRF(keywordResults, vectorResults, k);
	}

	/** Seeds the vector cache from a previously persisted `embeddings.json`.
	 * A provider/model/dims mismatch against current settings discards it —
	 * safe, since the store is a rebuildable per-device cache. */
	loadEmbeddingStore(json: string): void {
		const records = deserializeStore(json, this.embeddingHeader());
		this.semantic.loadCache(records);
	}

	/** Serializes the current vector cache for persistence to `embeddings.json`. */
	serializeEmbeddingStore(): string {
		return serializeStore(
			this.embeddingHeader(),
			this.semantic.persistRecords(),
		);
	}

	/** Drops all cached vectors, forcing a full re-embed on the next `build()`. */
	clearEmbeddingCache(): void {
		this.semantic.clear();
	}

	embeddingStatus(): { embedded: number; total: number; pending: number } {
		return {
			embedded: this.semantic.embeddedCount(),
			total: this.semantic.totalCount(),
			pending: this.semantic.pendingCount(),
		};
	}
}

export type { VaultChunk } from "./chunk";
export { chunkNote } from "./chunk";

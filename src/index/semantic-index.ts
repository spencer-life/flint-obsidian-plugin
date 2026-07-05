import type { EmbeddingProvider } from "../providers/embeddings";
import { EmbeddingRateLimitError } from "../providers/embeddings";
import type { VaultChunk } from "./chunk";
import { type StoredChunkRecord, sha256Hex } from "./embedding-store";

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(vector: Float32Array): Float32Array {
	let sumSq = 0;
	for (let i = 0; i < vector.length; i++) {
		const v = vector[i] ?? 0;
		sumSq += v * v;
	}
	const norm = Math.sqrt(sumSq);
	if (norm === 0) return vector;

	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) {
		out[i] = (vector[i] ?? 0) / norm;
	}
	return out;
}

function dot(a: Float32Array, b: Float32Array): number {
	const len = Math.min(a.length, b.length);
	let sum = 0;
	for (let i = 0; i < len; i++) {
		sum += (a[i] ?? 0) * (b[i] ?? 0);
	}
	return sum;
}

interface IndexedRecord extends StoredChunkRecord {
	/** Vector is always stored pre-normalized. */
	vector: Float32Array;
}

export interface EmbedRequestOptions {
	model: string;
	dimensions?: number;
}

/**
 * In-memory semantic index: `chunkId -> record` for retrieval/removal
 * bookkeeping per file, plus a content-hash cache so re-embedding only ever
 * happens for chunks whose text actually changed (hash-keyed, so shifting
 * positional `path#n` ids across edits never triggers spurious re-embeds).
 *
 * Embedding failures never throw out of `upsertFile`: a 429 is retried with
 * backoff (honoring `Retry-After`) up to `MAX_RETRIES`; any other failure, or
 * a retry budget exhausted, parks the affected chunks as "pending" and moves
 * on — those chunks simply aren't in the vector index yet (keyword search
 * still covers them) and will be retried on the next `upsertFile` pass since
 * their hash is never cached.
 */
export class SemanticIndex {
	private byId = new Map<string, IndexedRecord>();
	private cache = new Map<string, StoredChunkRecord>();
	private pathToIds = new Map<string, string[]>();
	private pendingHashes = new Set<string>();

	/** Seeds the hash cache from a previously persisted store (skips re-embedding unchanged chunks). */
	loadCache(records: StoredChunkRecord[]): void {
		for (const record of records) {
			this.cache.set(record.hash, record);
		}
	}

	removePath(path: string): void {
		const ids = this.pathToIds.get(path);
		if (!ids) return;
		for (const id of ids) this.byId.delete(id);
		this.pathToIds.delete(path);
	}

	/** Re-indexes one file's chunks: reuses cached vectors by content hash,
	 * embeds only what's new (when a provider is configured), and never blocks
	 * on embedding failures. */
	async upsertFile(
		path: string,
		chunks: VaultChunk[],
		provider: EmbeddingProvider | null,
		opts: EmbedRequestOptions,
	): Promise<void> {
		this.removePath(path);

		const ids: string[] = [];
		const toEmbed: { chunk: VaultChunk; hash: string }[] = [];

		for (const chunk of chunks) {
			const hash = await sha256Hex(`${chunk.heading}\n${chunk.text}`);
			ids.push(chunk.id);

			const cached = this.cache.get(hash);
			if (cached) {
				this.byId.set(chunk.id, { ...cached, vector: cached.vector });
				this.pendingHashes.delete(hash);
			} else if (provider) {
				toEmbed.push({ chunk, hash });
			}
		}
		this.pathToIds.set(path, ids);

		if (provider && toEmbed.length > 0) {
			await this.embedChunks(provider, path, toEmbed, opts);
		}
	}

	private async embedChunks(
		provider: EmbeddingProvider,
		path: string,
		items: { chunk: VaultChunk; hash: string }[],
		opts: EmbedRequestOptions,
	): Promise<void> {
		const texts = items.map(
			(item) => `${item.chunk.heading}\n${item.chunk.text}`,
		);

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const vectors = await provider.embed(texts, opts);
				for (let i = 0; i < items.length; i++) {
					const item = items[i];
					const vector = vectors[i];
					if (!item || !vector) continue;

					const record: StoredChunkRecord = {
						hash: item.hash,
						path,
						heading: item.chunk.heading,
						text: item.chunk.text,
						vector: normalize(vector),
					};
					this.cache.set(item.hash, record);
					this.byId.set(item.chunk.id, record);
					this.pendingHashes.delete(item.hash);
				}
				return;
			} catch (err) {
				if (err instanceof EmbeddingRateLimitError && attempt < MAX_RETRIES) {
					const waitMs =
						(err.retryAfterSeconds ?? (BASE_BACKOFF_MS / 1000) * 2 ** attempt) *
						1000;
					await sleep(waitMs);
					continue;
				}
				// Retry budget exhausted, or a non-rate-limit failure (offline,
				// bad key, provider error): park these chunks and move on —
				// never block indexing/chat on embedding failures.
				for (const item of items) this.pendingHashes.add(item.hash);
				return;
			}
		}
	}

	/** Top-k chunks by normalized dot product against `queryVector`. */
	retrieve(queryVector: Float32Array, k: number): VaultChunk[] {
		const normalizedQuery = normalize(queryVector);
		const scored: { id: string; score: number }[] = [];

		for (const [id, record] of this.byId) {
			scored.push({ id, score: dot(normalizedQuery, record.vector) });
		}
		scored.sort((a, b) => b.score - a.score);

		const results: VaultChunk[] = [];
		for (const { id } of scored.slice(0, k)) {
			const record = this.byId.get(id);
			if (!record) continue;
			results.push({
				id,
				path: record.path,
				heading: record.heading,
				text: record.text,
			});
		}
		return results;
	}

	/** Every cached chunk, deduped by content hash — the store's persistence source. */
	persistRecords(): StoredChunkRecord[] {
		return Array.from(this.cache.values());
	}

	embeddedCount(): number {
		return this.byId.size;
	}

	totalCount(): number {
		let total = 0;
		for (const ids of this.pathToIds.values()) total += ids.length;
		return total;
	}

	pendingCount(): number {
		return this.pendingHashes.size;
	}

	/** Drops all cached vectors and index state (used by "Rebuild embeddings"). */
	clear(): void {
		this.byId.clear();
		this.cache.clear();
		this.pathToIds.clear();
		this.pendingHashes.clear();
	}
}

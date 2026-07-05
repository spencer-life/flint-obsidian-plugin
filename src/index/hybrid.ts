import type { VaultChunk } from "./chunk";

// Standard RRF smoothing constant: dampens the influence of rank 1 vs rank 2
// so a chunk near the top of either ranking still contributes meaningfully
// even if it's not literally first.
const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: merges two independently-ranked chunk lists
 * (keyword hits, vector hits) into one ranking by summing `1 / (RRF_K +
 * rank)` per list a chunk appears in (rank is 1-indexed), then sorting
 * descending. Avoids having to normalize BM25-ish and cosine scores onto a
 * shared scale. Pure function — no I/O.
 */
export function fuseRRF(
	keywordHits: VaultChunk[],
	vectorHits: VaultChunk[],
	k: number,
): VaultChunk[] {
	const scores = new Map<string, number>();
	const chunkById = new Map<string, VaultChunk>();

	const addRanked = (hits: VaultChunk[]) => {
		hits.forEach((chunk, index) => {
			const rank = index + 1;
			scores.set(chunk.id, (scores.get(chunk.id) ?? 0) + 1 / (RRF_K + rank));
			chunkById.set(chunk.id, chunk);
		});
	};

	addRanked(keywordHits);
	addRanked(vectorHits);

	return Array.from(scores.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, k)
		.map(([id]) => chunkById.get(id))
		.filter((chunk): chunk is VaultChunk => chunk !== undefined);
}

// Chunk size for the binary-string conversion below: spreading a large
// Uint8Array into `String.fromCharCode(...bytes)` in one call overflows the
// call stack (observed well before 1M elements on V8); converting in
// bounded-size slices keeps this safe at any vector-store size.
const BASE64_CHUNK_SIZE = 0x8000;

/** Encodes a `Float32Array` as a base64 string (mobile-safe: `btoa`, no `Buffer`). */
export function float32ArrayToBase64(vector: Float32Array): string {
	const bytes = new Uint8Array(
		vector.buffer,
		vector.byteOffset,
		vector.byteLength,
	);
	let binary = "";
	for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
		const slice = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

/** Decodes a base64 string produced by `float32ArrayToBase64` back to a `Float32Array`. */
export function base64ToFloat32Array(base64: string): Float32Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return new Float32Array(bytes.buffer);
}

/** SHA-256 hex digest via `crypto.subtle` — mobile-safe, no Node APIs. */
export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Identifies the embedding config a store was built with. A mismatch against
 * the currently configured provider/model (or, when the caller cares, dims)
 * means the vectors are no longer comparable and the whole store must be
 * invalidated rather than partially reused.
 */
export interface EmbeddingStoreHeader {
	provider: string;
	model: string;
	/** `undefined` for providers (e.g. Ollama) that ignore a dims request —
	 * skips the dims check entirely so an adaptive actual dim count doesn't
	 * spuriously invalidate the cache. */
	dims: number | undefined;
}

/** One cached chunk: keyed by content hash so positional chunk ids (which
 * shift on edits) never matter for cache reuse. */
export interface StoredChunkRecord {
	hash: string;
	path: string;
	heading: string;
	text: string;
	vector: Float32Array;
}

interface RawStoreFile {
	header?: Partial<EmbeddingStoreHeader>;
	records?: unknown;
}

interface RawStoredRecord {
	hash?: unknown;
	path?: unknown;
	heading?: unknown;
	text?: unknown;
	vector?: unknown;
}

/** Serializes a store to the on-disk JSON shape (`embeddings.json`). */
export function serializeStore(
	header: EmbeddingStoreHeader,
	records: StoredChunkRecord[],
): string {
	return JSON.stringify({
		header,
		records: records.map((record) => ({
			hash: record.hash,
			path: record.path,
			heading: record.heading,
			text: record.text,
			vector: float32ArrayToBase64(record.vector),
		})),
	});
}

/**
 * Parses a persisted store, returning `[]` when the JSON is corrupt or the
 * header doesn't match `expectedHeader` (provider/model change, or a dims
 * change when `expectedHeader.dims` is defined) — both cases mean "start
 * cold," which is always safe since the store is a rebuildable cache.
 */
export function deserializeStore(
	json: string,
	expectedHeader: EmbeddingStoreHeader,
): StoredChunkRecord[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}

	if (typeof parsed !== "object" || parsed === null) return [];
	const raw = parsed as RawStoreFile;

	const header = raw.header;
	if (
		!header ||
		header.provider !== expectedHeader.provider ||
		header.model !== expectedHeader.model ||
		(expectedHeader.dims !== undefined && header.dims !== expectedHeader.dims)
	) {
		return [];
	}

	if (!Array.isArray(raw.records)) return [];

	const records: StoredChunkRecord[] = [];
	for (const item of raw.records as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const rec = item as RawStoredRecord;
		if (
			typeof rec.hash !== "string" ||
			typeof rec.path !== "string" ||
			typeof rec.heading !== "string" ||
			typeof rec.text !== "string" ||
			typeof rec.vector !== "string"
		) {
			continue;
		}
		try {
			records.push({
				hash: rec.hash,
				path: rec.path,
				heading: rec.heading,
				text: rec.text,
				vector: base64ToFloat32Array(rec.vector),
			});
		} catch {
			// Corrupt individual record — skip it, keep the rest of the store.
		}
	}
	return records;
}

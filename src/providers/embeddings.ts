import { requestUrl } from "obsidian";
import type { FlintSettings } from "../settings";
import { NIM_BASE_URL, validateBaseUrl } from "./openai-compatible";

export interface EmbedOptions {
	model: string;
	/** Matryoshka truncation target. Some providers (e.g. Ollama) ignore this. */
	dimensions?: number;
	signal?: AbortSignal;
}

/**
 * Embedding provider abstraction, deliberately separate from the chat
 * `Provider` interface: the active chat provider (e.g. Anthropic) may have no
 * embeddings API at all.
 */
export interface EmbeddingProvider {
	name: string;
	embed(texts: string[], opts: EmbedOptions): Promise<Float32Array[]>;
}

/** Thrown on a 429 response so callers can back off instead of parking immediately. */
export class EmbeddingRateLimitError extends Error {
	constructor(
		message: string,
		public readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "EmbeddingRateLimitError";
	}
}

// Well under OpenAI's 2048-input cap; keeps individual requests small enough
// to retry/back off cheaply.
const MAX_BATCH = 100;

export interface OpenAICompatibleEmbeddingsConfig {
	baseUrl: string;
	apiKey: string;
}

/** Reads a header case-insensitively from an Obsidian `requestUrl` response. */
function getHeader(
	headers: Record<string, string> | undefined,
	name: string,
): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === lower) return value;
	}
	return undefined;
}

/**
 * `/embeddings` client for any OpenAI-compatible endpoint (OpenAI, NVIDIA
 * NIM, Ollama). Uses `requestUrl` (mobile-safe, no CORS) and batches inputs
 * so a large re-embed never sends an oversized request body.
 */
export class OpenAICompatibleEmbeddings implements EmbeddingProvider {
	name = "openai-compatible-embeddings";

	constructor(private config: OpenAICompatibleEmbeddingsConfig) {}

	async embed(texts: string[], opts: EmbedOptions): Promise<Float32Array[]> {
		validateBaseUrl(this.config.baseUrl);

		const vectors: Float32Array[] = [];
		for (let i = 0; i < texts.length; i += MAX_BATCH) {
			const batch = texts.slice(i, i + MAX_BATCH);
			vectors.push(...(await this.embedBatch(batch, opts)));
		}
		return vectors;
	}

	private async embedBatch(
		batch: string[],
		opts: EmbedOptions,
	): Promise<Float32Array[]> {
		const body: Record<string, unknown> = {
			model: opts.model,
			input: batch,
		};
		if (opts.dimensions !== undefined) body.dimensions = opts.dimensions;

		const response = await requestUrl({
			url: `${this.config.baseUrl}/embeddings`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			throw: false,
		});

		const data = response.json as
			| {
					data?: { embedding?: number[]; index?: number }[];
					error?: { message?: string };
					detail?: string;
					message?: string;
			  }
			| undefined;

		if (response.status === 429) {
			const retryAfterHeader = getHeader(response.headers, "retry-after");
			const retryAfterSeconds = retryAfterHeader
				? Number.parseFloat(retryAfterHeader)
				: undefined;
			throw new EmbeddingRateLimitError(
				"Embedding provider rate limited (429)",
				Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
			);
		}

		if (response.status >= 400) {
			const apiMsg = data?.error?.message ?? data?.detail ?? data?.message;
			throw new Error(
				`Embedding provider error (${response.status})${apiMsg ? `: ${apiMsg}` : ""}`,
			);
		}

		const items = data?.data ?? [];
		const sorted = [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		return sorted.map((item) => Float32Array.from(item.embedding ?? []));
	}
}

/** Ollama ignores the `dimensions` truncation param — never request it. */
export function resolveEmbeddingDimensions(
	settings: FlintSettings,
): number | undefined {
	return settings.embeddingProvider === "ollama"
		? undefined
		: settings.embeddingDimensions;
}

/**
 * Resolves the configured embedding provider, or `null` when embeddings are
 * unavailable (`embeddingProvider: "none"`, or no key configured for the
 * chosen provider). Ollama needs no key (local server).
 */
export function getEmbeddingProvider(
	settings: FlintSettings,
): EmbeddingProvider | null {
	switch (settings.embeddingProvider) {
		case "none":
			return null;
		case "openai": {
			const apiKey = settings.providers.openai.apiKey;
			if (!apiKey) return null;
			return new OpenAICompatibleEmbeddings({
				baseUrl: settings.providers.openai.baseUrl,
				apiKey,
			});
		}
		case "nim": {
			const apiKey = settings.providers.nim.apiKey;
			if (!apiKey) return null;
			return new OpenAICompatibleEmbeddings({
				baseUrl: NIM_BASE_URL,
				apiKey,
			});
		}
		case "ollama":
			return new OpenAICompatibleEmbeddings({
				baseUrl: settings.providers.ollama.baseUrl,
				apiKey: "ollama",
			});
		default:
			return null;
	}
}

import { sha256Hex } from "../index/embedding-store";
import type { FlintSettings, ProviderId } from "../settings";
import { AnthropicProvider } from "./anthropic";
import { NIM_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible";
import type { Provider } from "./types";

export type { ChatMessage, ChatOptions, Provider } from "./types";

/**
 * Factory that resolves the currently-configured provider from settings.
 * STUB: no caching/memoization of provider instances yet.
 */
export function getProvider(settings: FlintSettings): Provider {
	switch (settings.activeProvider) {
		case "anthropic":
			return new AnthropicProvider({
				apiKey: settings.providers.anthropic.apiKey,
			});
		case "nim":
			return new OpenAICompatibleProvider({
				baseUrl: NIM_BASE_URL,
				apiKey: settings.providers.nim.apiKey,
			});
		case "openai":
			return new OpenAICompatibleProvider({
				baseUrl: settings.providers.openai.baseUrl,
				apiKey: settings.providers.openai.apiKey,
			});
		case "ollama":
			return new OpenAICompatibleProvider({
				baseUrl: settings.providers.ollama.baseUrl,
				apiKey: "ollama",
			});
	}
}

/** Builds the config-identifying `{baseUrl, apiKey}` pair for a given (not
 * necessarily active) provider id, used both to construct that provider
 * directly and as a cache key. */
function resolveConfig(
	providerId: ProviderId,
	settings: FlintSettings,
): { baseUrl: string; apiKey: string } {
	switch (providerId) {
		case "anthropic":
			return { baseUrl: "", apiKey: settings.providers.anthropic.apiKey };
		case "nim":
			return { baseUrl: NIM_BASE_URL, apiKey: settings.providers.nim.apiKey };
		case "openai":
			return {
				baseUrl: settings.providers.openai.baseUrl,
				apiKey: settings.providers.openai.apiKey,
			};
		case "ollama":
			return { baseUrl: settings.providers.ollama.baseUrl, apiKey: "ollama" };
	}
}

function buildProvider(
	providerId: ProviderId,
	config: { baseUrl: string; apiKey: string },
): Provider {
	if (providerId === "anthropic") {
		return new AnthropicProvider({ apiKey: config.apiKey });
	}
	return new OpenAICompatibleProvider({
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
	});
}

interface ModelsCacheEntry {
	models: string[];
	fetchedAt: number;
	inflight?: Promise<string[]>;
}

const MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
const modelsCache = new Map<string, ModelsCacheEntry>();

/**
 * Fetches the model id list for a specific provider (NOT necessarily the
 * active one — the caller picks `providerId`). Builds that provider directly
 * from its own `{baseUrl, apiKey}` config rather than routing through
 * `getProvider()`, which only ever builds the currently-active provider.
 * Results are cached in-memory for 10 minutes, keyed by provider+config so a
 * changed API key or base URL busts the cache; concurrent calls for the same
 * key share one in-flight request; failed fetches are never cached.
 */
export async function fetchModels(
	providerId: ProviderId,
	settings: FlintSettings,
	opts?: { force?: boolean },
): Promise<string[]> {
	const config = resolveConfig(providerId, settings);
	// Fingerprint the key rather than holding it in plaintext in the cache Map.
	const key = `${providerId}|${config.baseUrl}|${await sha256Hex(config.apiKey)}`;
	const cached = modelsCache.get(key);

	if (cached?.inflight) return cached.inflight;

	if (
		!opts?.force &&
		cached &&
		Date.now() - cached.fetchedAt < MODELS_CACHE_TTL_MS
	) {
		return cached.models;
	}

	const provider = buildProvider(providerId, config);
	const inflight = provider.listModels();
	modelsCache.set(key, {
		models: cached?.models ?? [],
		fetchedAt: cached?.fetchedAt ?? 0,
		inflight,
	});

	try {
		const models = await inflight;
		modelsCache.set(key, { models, fetchedAt: Date.now() });
		return models;
	} catch (err) {
		modelsCache.delete(key);
		throw err;
	}
}

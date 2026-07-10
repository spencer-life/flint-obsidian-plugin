import { Notice } from "obsidian";
import { sha256Hex } from "../index/embedding-store";
import {
	type FlintSettings,
	type ProviderId,
	resolveTaskModel,
	type TaskModelKey,
} from "../settings";
import { AnthropicProvider } from "./anthropic";
import { NIM_BASE_URL, OpenAICompatibleProvider } from "./openai-compatible";
import type { ChatMessage, ChatOptions, Provider } from "./types";

export type { ChatMessage, ChatOptions, Provider } from "./types";

/** Fixed sampling/length defaults per background task, applied on top of
 * whatever the resolved model/provider is — independent of Advanced sampling
 * settings, which task-model calls never read. `vision` carries no defaults:
 * it's resolved through `resolveTaskModel`/`getProviderFor` directly from the
 * panel, not through `chatWithTaskModel`. */
const TASK_CHAT_DEFAULTS: Record<
	TaskModelKey,
	Pick<ChatOptions, "temperature" | "reasoning" | "maxTokens">
> = {
	triage: { temperature: 0.2, reasoning: "nonthink" },
	organize: { temperature: 0.2, reasoning: "nonthink" },
	dashboard: { maxTokens: 8192 },
	htmlGenerate: { maxTokens: 8192 },
	vision: {},
};

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

/** Builds a provider for a SPECIFIC (not necessarily active) provider id —
 * e.g. the vision task-model pair, which can point at a different provider
 * than the active chat model. */
export function getProviderFor(
	providerId: ProviderId,
	settings: FlintSettings,
): Provider {
	return buildProvider(providerId, resolveConfig(providerId, settings));
}

/** Non-null Advanced sampling overrides from settings, ready to spread into
 * `ChatOptions` — `null` fields are omitted so provider request bodies drop
 * them rather than sending an explicit `null`. */
export function resolveSampling(
	settings: FlintSettings,
): Pick<ChatOptions, "temperature" | "topP" | "seed"> {
	const { temperature, topP, seed } = settings.sampling;
	return {
		...(temperature !== null ? { temperature } : {}),
		...(topP !== null ? { topP } : {}),
		...(seed !== null ? { seed } : {}),
	};
}

/** How much of a provider error message reaches a user-facing Notice. */
const NOTICE_REASON_CHARS = 200;

/**
 * Runs a background-task chat call with the task's model override, built on
 * the override's OWN provider (an override can outlive a provider switch),
 * falling back to the chat `activeModel` on the active provider if the
 * override fails. The fallback Notice names the model, the provider, and the
 * ACTUAL error reason — a swallowed reason made real failures (rate limits,
 * reasoning-only replies) look like "misconfigured override" for weeks.
 */
export async function chatWithTaskModel(
	settings: FlintSettings,
	task: TaskModelKey,
	messages: ChatMessage[],
): Promise<string> {
	const resolved = resolveTaskModel(settings, task);
	const isActiveModel =
		resolved.providerId === settings.activeProvider &&
		resolved.model === settings.activeModel;

	const provider = buildProvider(
		resolved.providerId,
		resolveConfig(resolved.providerId, settings),
	);
	const defaults = TASK_CHAT_DEFAULTS[task];
	if (isActiveModel) {
		return provider.chat(messages, { model: resolved.model, ...defaults });
	}
	try {
		return await provider.chat(messages, {
			model: resolved.model,
			...defaults,
		});
	} catch (error) {
		const reason = (
			error instanceof Error ? error.message : String(error)
		).slice(0, NOTICE_REASON_CHARS);
		new Notice(
			`Flint: task model "${resolved.model}" (${resolved.providerId}) failed: ${reason} — retrying with the chat model.`,
			10000,
		);
		return getProvider(settings).chat(messages, {
			model: settings.activeModel,
			...defaults,
		});
	}
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

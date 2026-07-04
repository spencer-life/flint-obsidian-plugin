import type { FlintSettings } from "../settings";
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

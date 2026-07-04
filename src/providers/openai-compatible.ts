import { requestUrl } from "obsidian";
import type { ChatMessage, ChatOptions, Provider } from "./types";

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface OpenAICompatibleConfig {
	baseUrl: string;
	apiKey: string;
}

/**
 * Provider adapter for any OpenAI-compatible `/chat/completions` endpoint
 * (NVIDIA NIM, Ollama, OpenAI itself). Non-streaming for this skeleton —
 * streaming support lands in a later pass.
 */
export class OpenAICompatibleProvider implements Provider {
	name = "openai-compatible";

	constructor(private config: OpenAICompatibleConfig) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const response = await requestUrl({
			url: `${this.config.baseUrl}/chat/completions`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.config.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: opts.model,
				messages,
				max_tokens: opts.maxTokens,
			}),
		});

		// STUB: no streaming, no retry/error-shape handling yet.
		return response.json.choices[0].message.content;
	}
}

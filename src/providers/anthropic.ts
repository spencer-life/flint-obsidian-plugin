import { requestUrl } from "obsidian";
import type { ChatMessage, ChatOptions, Provider } from "./types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicConfig {
	apiKey: string;
}

/**
 * Anthropic Messages API adapter. Anthropic takes `system` as a top-level
 * field rather than a message with role "system", so we extract it here.
 * Non-streaming for this skeleton.
 */
export class AnthropicProvider implements Provider {
	name = "anthropic";

	constructor(private config: AnthropicConfig) {}

	async chat(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
		const systemMessage = messages
			.filter((message) => message.role === "system")
			.map((message) => message.content)
			.join("\n\n");

		const conversationMessages = messages
			.filter((message) => message.role !== "system")
			.map((message) => ({ role: message.role, content: message.content }));

		const response = await requestUrl({
			url: ANTHROPIC_API_URL,
			method: "POST",
			headers: {
				"x-api-key": this.config.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: opts.model,
				max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
				system: systemMessage || undefined,
				messages: conversationMessages,
			}),
		});

		// STUB: no streaming, no retry/error-shape handling yet.
		return response.json.content[0].text;
	}
}

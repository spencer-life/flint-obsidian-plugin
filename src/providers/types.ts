export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface ChatOptions {
	model: string;
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface Provider {
	name: string;
	chat(messages: ChatMessage[], opts: ChatOptions): Promise<string>;
}

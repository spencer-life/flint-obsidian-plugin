import type { ToolDefinition } from "../providers/types";

/**
 * Pure tool metadata for the chat agent: definitions sent to the provider,
 * the mutating/read-only split (mutating calls suspend on user confirmation),
 * and tolerant argument parsing. No `obsidian` imports — unit-testable like
 * organize-parse.
 */

export const MUTATING_TOOL_NAMES = new Set([
	"create_note",
	"append_to_note",
	"edit_note",
	"move_note",
	"add_tags",
]);

export function isMutatingTool(name: string): boolean {
	return MUTATING_TOOL_NAMES.has(name);
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: "search_vault",
		description:
			"Search the vault for notes relevant to a query (semantic + keyword). " +
			"Returns note paths with matching excerpts. Use this FIRST to find " +
			"notes — never guess a path.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "What to search for." },
				k: {
					type: "number",
					description: "How many results (1-10, default 6).",
				},
			},
			required: ["query"],
		},
	},
	{
		name: "read_note",
		description:
			"Read a note's full content by its exact vault path. Read a note " +
			"before editing or moving it.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Exact vault path, e.g. '01 Projects/Site/Plan.md'.",
				},
			},
			required: ["path"],
		},
	},
	{
		name: "list_folder_tree",
		description:
			"List the vault's folder hierarchy. Use to pick real destinations — " +
			"only folders returned here exist.",
		parameters: { type: "object", properties: {} },
	},
	{
		name: "create_note",
		description:
			"Create a new markdown note at the given vault path (requires user " +
			"approval). Fails if a file already exists there.",
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description:
						"Vault path for the new note, e.g. '01 Projects/Idea.md'.",
				},
				content: { type: "string", description: "Full note content." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "append_to_note",
		description:
			"Append content to the end of an existing note (requires user approval).",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact vault path." },
				content: { type: "string", description: "Content to append." },
			},
			required: ["path", "content"],
		},
	},
	{
		name: "edit_note",
		description:
			"Replace one exact text occurrence in a note (requires user approval). " +
			"old_text must match exactly once — read the note first and copy the " +
			"text verbatim.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact vault path." },
				old_text: {
					type: "string",
					description: "Exact existing text to replace (must be unique).",
				},
				new_text: { type: "string", description: "Replacement text." },
			},
			required: ["path", "old_text", "new_text"],
		},
	},
	{
		name: "move_note",
		description:
			"Move a note into an existing folder (requires user approval). The " +
			"destination must be a real folder from list_folder_tree. Links to " +
			"the note keep working.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact vault path of the note." },
				destination: {
					type: "string",
					description: "Exact existing destination folder path.",
				},
			},
			required: ["path", "destination"],
		},
	},
	{
		name: "add_tags",
		description:
			"Add tags to a note's frontmatter (requires user approval). Lowercase, " +
			"[a-z0-9/_-] only.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Exact vault path." },
				tags: {
					type: "array",
					items: { type: "string" },
					description: "Tags to add.",
				},
			},
			required: ["path", "tags"],
		},
	},
];

/**
 * Tolerant parse of a model-emitted tool-argument JSON string: empty input
 * is an empty object (some providers stream no arguments for zero-arg
 * tools); anything unparseable or non-object throws a descriptive error the
 * loop converts into a tool-result error (the model can retry) instead of a
 * crashed send.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		throw new Error("Arguments were not valid JSON.");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Arguments must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

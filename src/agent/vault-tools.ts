import { type App, normalizePath, TFile } from "obsidian";
import { nextAvailablePath } from "../generate/html";
import type { VaultIndex } from "../index/vault-index";
import { appendFlintLog } from "../log/flint-log";
import type { FlintSettings } from "../settings";
import { sanitizeOrganizeTags } from "../triage/organize-parse";
import { computeDestinationAllowlist, renderFolderTree } from "./vault-tree";

/** Cap on a read_note result — a huge note must not blow up the transcript. */
const READ_NOTE_CHARS = 6000;

/** Cap on each search result's excerpt. */
const SEARCH_SNIPPET_CHARS = 300;

const MAX_SEARCH_RESULTS = 10;

const FOLDER_TREE_DEPTH = 4;
const FOLDER_TREE_ENTRIES = 150;

export interface ToolExecutionResult {
	content: string;
	isError: boolean;
}

function truncate(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)}\n[truncated]` : text;
}

/** Wikilink-safe rendering of a vault path for Flint Log lines. */
function logLink(path: string): string {
	return `[[${path.replace(/\.md$/i, "").replace(/[[\]`]/g, "")}]]`;
}

/**
 * Executes the chat agent's vault tools against the real vault. Every path
 * is normalized and traversal-rejected before use; moves are validated
 * against the live destination allowlist (same one organize uses); all
 * writes go through Vault/FileManager APIs so links survive and nothing
 * touches the filesystem directly. Errors come back as `isError` results —
 * the model can read them and adjust — never as thrown exceptions.
 */
export class VaultToolExecutor {
	constructor(
		private app: App,
		private settings: FlintSettings,
		private vaultIndex: VaultIndex,
	) {}

	/** Normalizes and validates a model-supplied vault path. Throws on
	 * anything that could escape the vault or reference nothing. */
	private validatePath(raw: unknown, field = "path"): string {
		if (typeof raw !== "string" || raw.trim().length === 0) {
			throw new Error(`Missing or empty "${field}".`);
		}
		const path = normalizePath(raw.trim());
		if (
			path.startsWith("/") ||
			path === ".." ||
			path.startsWith("../") ||
			path.includes("/../") ||
			path.endsWith("/..") ||
			path.split("/").some((segment) => segment.startsWith("."))
		) {
			throw new Error(
				`Invalid ${field}: "${raw}" — paths must stay inside the vault.`,
			);
		}
		return path;
	}

	private noteAt(path: string): TFile {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			throw new Error(
				`No note exists at "${path}". Use search_vault or list_folder_tree to find real paths.`,
			);
		}
		return file;
	}

	private destinationAllowlist(): string[] {
		return computeDestinationAllowlist(this.app.vault.getRoot(), {
			excludedFolders: [
				...this.settings.excludeFolders,
				...this.settings.organizeExcludeFolders,
			],
			captureFolder: normalizePath(this.settings.captureFolder),
		});
	}

	private timestamp(): string {
		try {
			return window.moment().format("YYYY-MM-DD HH:mm");
		} catch {
			return new Date().toISOString().slice(0, 16).replace("T", " ");
		}
	}

	private async log(line: string): Promise<void> {
		await appendFlintLog(this.app.vault, `- ${this.timestamp()} — ${line}`);
	}

	/** One-line human-readable summary of a proposed call, for the confirm
	 * card header. Never throws on malformed args. */
	describeCall(name: string, args: Record<string, unknown>): string {
		const str = (key: string) =>
			typeof args[key] === "string" ? (args[key] as string) : "?";
		switch (name) {
			case "search_vault":
				return `Search: ${str("query")}`;
			case "read_note":
				return `Read ${str("path")}`;
			case "list_folder_tree":
				return "List folders";
			case "create_note":
				return `Create ${str("path")}`;
			case "append_to_note":
				return `Append to ${str("path")}`;
			case "edit_note":
				return `Edit ${str("path")}`;
			case "move_note":
				return `Move ${str("path")} → ${str("destination")}`;
			case "add_tags":
				return `Tag ${str("path")}`;
			default:
				return name;
		}
	}

	async execute(
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolExecutionResult> {
		try {
			switch (name) {
				case "search_vault":
					return { content: await this.searchVault(args), isError: false };
				case "read_note":
					return { content: await this.readNote(args), isError: false };
				case "list_folder_tree":
					return { content: this.listFolderTree(), isError: false };
				case "create_note":
					return { content: await this.createNote(args), isError: false };
				case "append_to_note":
					return { content: await this.appendToNote(args), isError: false };
				case "edit_note":
					return { content: await this.editNote(args), isError: false };
				case "move_note":
					return { content: await this.moveNote(args), isError: false };
				case "add_tags":
					return { content: await this.addTags(args), isError: false };
				default:
					return { content: `Unknown tool "${name}".`, isError: true };
			}
		} catch (error) {
			return {
				content: error instanceof Error ? error.message : String(error),
				isError: true,
			};
		}
	}

	private async searchVault(args: Record<string, unknown>): Promise<string> {
		if (
			typeof args["query"] !== "string" ||
			args["query"].trim().length === 0
		) {
			throw new Error('Missing or empty "query".');
		}
		const k = Math.min(
			Math.max(1, typeof args["k"] === "number" ? Math.floor(args["k"]) : 6),
			MAX_SEARCH_RESULTS,
		);
		const chunks = await this.vaultIndex.retrieve(args["query"], k);
		if (chunks.length === 0) return "No matching notes found.";
		return chunks
			.map((chunk, i) => {
				const header = chunk.heading
					? `${chunk.path} — ${chunk.heading}`
					: chunk.path;
				return `[${i + 1}] ${header}\n${truncate(chunk.text, SEARCH_SNIPPET_CHARS)}`;
			})
			.join("\n\n");
	}

	private async readNote(args: Record<string, unknown>): Promise<string> {
		const path = this.validatePath(args["path"]);
		const file = this.noteAt(path);
		const content = await this.app.vault.cachedRead(file);
		return truncate(content, READ_NOTE_CHARS);
	}

	private listFolderTree(): string {
		const tree = renderFolderTree(this.app.vault.getRoot(), {
			maxDepth: FOLDER_TREE_DEPTH,
			maxEntries: FOLDER_TREE_ENTRIES,
		});
		return tree.length > 0 ? tree : "(vault has no folders)";
	}

	private async createNote(args: Record<string, unknown>): Promise<string> {
		let path = this.validatePath(args["path"]);
		if (!path.toLowerCase().endsWith(".md")) path = `${path}.md`;
		if (typeof args["content"] !== "string") {
			throw new Error('Missing "content".');
		}
		if (this.app.vault.getAbstractFileByPath(path)) {
			throw new Error(
				`"${path}" already exists — pick another path or use append_to_note/edit_note.`,
			);
		}
		const parentPath = path.includes("/")
			? path.slice(0, path.lastIndexOf("/"))
			: "";
		if (
			parentPath.length > 0 &&
			!this.app.vault.getAbstractFileByPath(parentPath)
		) {
			await this.app.vault.createFolder(parentPath);
		}
		await this.app.vault.create(path, args["content"]);
		await this.log(`chat: created ${logLink(path)}`);
		return `Created "${path}".`;
	}

	private async appendToNote(args: Record<string, unknown>): Promise<string> {
		const path = this.validatePath(args["path"]);
		if (typeof args["content"] !== "string") {
			throw new Error('Missing "content".');
		}
		const file = this.noteAt(path);
		const addition = args["content"];
		await this.app.vault.process(
			file,
			(data) => `${data.trimEnd()}\n\n${addition}\n`,
		);
		await this.log(`chat: appended to ${logLink(path)}`);
		return `Appended to "${path}".`;
	}

	private async editNote(args: Record<string, unknown>): Promise<string> {
		const path = this.validatePath(args["path"]);
		const oldText = args["old_text"];
		const newText = args["new_text"];
		if (typeof oldText !== "string" || oldText.length === 0) {
			throw new Error('Missing "old_text".');
		}
		if (typeof newText !== "string") {
			throw new Error('Missing "new_text".');
		}
		const file = this.noteAt(path);
		const content = await this.app.vault.read(file);
		const first = content.indexOf(oldText);
		if (first === -1) {
			throw new Error(
				`old_text not found in "${path}" — read the note and copy the text exactly.`,
			);
		}
		if (content.indexOf(oldText, first + 1) !== -1) {
			throw new Error(
				`old_text appears more than once in "${path}" — include more surrounding text to make it unique.`,
			);
		}
		await this.app.vault.process(file, (data) =>
			data.replace(oldText, newText),
		);
		await this.log(`chat: edited ${logLink(path)}`);
		return `Edited "${path}".`;
	}

	private async moveNote(args: Record<string, unknown>): Promise<string> {
		const path = this.validatePath(args["path"]);
		const destination = this.validatePath(args["destination"], "destination");
		const file = this.noteAt(path);

		// The safety boundary: a model-emitted destination is only ever
		// accepted by exact match against the live folder allowlist.
		const allowlist = this.destinationAllowlist();
		if (!allowlist.includes(destination)) {
			throw new Error(
				`"${destination}" is not an allowed destination folder. Call list_folder_tree and pick an existing folder exactly.`,
			);
		}

		const desiredPath = normalizePath(`${destination}/${file.name}`);
		if (desiredPath === file.path) {
			return `"${path}" is already in "${destination}".`;
		}
		const targetPath = nextAvailablePath(
			desiredPath,
			(candidate) =>
				candidate !== file.path &&
				this.app.vault.getAbstractFileByPath(candidate) !== null,
		);
		const oldPath = file.path;
		await this.app.fileManager.renameFile(file, targetPath);
		await this.log(
			`chat: moved ${logLink(targetPath)} ← was \`${oldPath.replace(/`/g, "'")}\``,
		);
		return `Moved "${oldPath}" to "${targetPath}".`;
	}

	private async addTags(args: Record<string, unknown>): Promise<string> {
		const path = this.validatePath(args["path"]);
		const tags = sanitizeOrganizeTags(args["tags"]);
		if (tags.length === 0) {
			throw new Error('No valid tags in "tags" (lowercase, [a-z0-9/_-] only).');
		}
		const file = this.noteAt(path);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existing = Array.isArray(frontmatter["tags"])
				? (frontmatter["tags"] as unknown[]).filter(
						(tag): tag is string => typeof tag === "string",
					)
				: [];
			frontmatter["tags"] = Array.from(new Set([...existing, ...tags]));
		});
		await this.log(`chat: tagged ${logLink(path)} (${tags.join(", ")})`);
		return `Added tags to "${path}": ${tags.join(", ")}.`;
	}
}

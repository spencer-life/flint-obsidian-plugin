import { TFolder } from "obsidian";

export interface AllowlistOptions {
	/** Folders (and everything under them) never offered as destinations —
	 * the union of the retrieval exclusions and the organize-specific ones. */
	excludedFolders: string[];
	/** The capture folder itself and its subfolders are never destinations
	 * (filing something "into the inbox" is a no-op with extra steps). */
	captureFolder: string;
}

function isWithin(path: string, folder: string): boolean {
	return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Builds the allowlist of real, existing vault folder paths a destination
 * suggestion may exactly match. Computed fresh from the live vault tree
 * every time (never cached, never hand-authored) so an LLM-emitted path can
 * never be trusted directly — only membership in this list matters. Shared
 * by the organize pipeline and the chat agent's move tool.
 */
export function computeDestinationAllowlist(
	root: TFolder,
	opts: AllowlistOptions,
): string[] {
	const folders: string[] = [];

	const isExcluded = (path: string) =>
		isWithin(path, opts.captureFolder) ||
		opts.excludedFolders.some((folder) => isWithin(path, folder));

	const walk = (folder: TFolder) => {
		for (const child of folder.children) {
			if (!(child instanceof TFolder)) continue;
			if (!isExcluded(child.path)) {
				folders.push(child.path);
			}
			walk(child);
		}
	};

	walk(root);
	return folders.sort();
}

export interface FolderTreeOptions {
	maxDepth: number;
	maxEntries: number;
}

/**
 * Renders the vault's folder hierarchy as an indented text tree for the
 * agent's system prompt — folders only, depth- and entry-capped so a huge
 * vault can't blow up the prompt. Appends a truncation marker when capped.
 */
export function renderFolderTree(
	root: TFolder,
	opts: FolderTreeOptions,
): string {
	const lines: string[] = [];
	let truncated = false;

	const walk = (folder: TFolder, depth: number) => {
		if (depth >= opts.maxDepth) return;
		const children = folder.children
			.filter((child): child is TFolder => child instanceof TFolder)
			.sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (lines.length >= opts.maxEntries) {
				truncated = true;
				return;
			}
			lines.push(`${"  ".repeat(depth)}${child.name}/`);
			walk(child, depth + 1);
		}
	};

	walk(root, 0);
	if (truncated) lines.push("… (tree truncated)");
	return lines.join("\n");
}

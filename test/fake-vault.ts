import type { App, TFile } from "obsidian";

export interface FakeFile {
	path: string;
	content: string;
}

/**
 * Minimal duck-typed `App` stand-in for `VaultIndex`. It only implements what
 * `src/index/vault-index.ts` actually calls at runtime: `vault.getMarkdownFiles()`
 * and `vault.cachedRead(file)`. Files are passed through as plain objects with
 * a `path` — `VaultIndex` never does an `instanceof TFile` check itself.
 */
export function createFakeApp(files: FakeFile[]): App {
	const byPath = new Map(files.map((file) => [file.path, file]));

	const vault = {
		getMarkdownFiles: () => files.map((file) => ({ path: file.path }) as TFile),
		cachedRead: async (file: TFile) => {
			const found = byPath.get(file.path);
			if (!found) throw new Error(`Unknown fake file: ${file.path}`);
			return found.content;
		},
	};

	return { vault } as unknown as App;
}

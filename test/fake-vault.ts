import type { App, TFile } from "obsidian";
import { FakeTFile } from "./obsidian-mock";

export interface FakeFile {
	path: string;
	content: string;
}

/**
 * Minimal duck-typed `App` stand-in for `VaultIndex` and the pipeline's
 * pinned-note reads. Implements what those call at runtime:
 * `vault.getMarkdownFiles()`, `vault.getAbstractFileByPath(path)`, and
 * `vault.cachedRead(file)`. Files are `FakeTFile` instances (obsidian-mock.ts's
 * stand-in for the real `TFile`, registered via `mock.module`) so `instanceof
 * TFile` checks in src code pass.
 */
export function createFakeApp(files: FakeFile[]): App {
	const byPath = new Map(files.map((file) => [file.path, file]));
	const tFiles = new Map(
		files.map((file) => [
			file.path,
			new FakeTFile(file.path) as unknown as TFile,
		]),
	);

	const vault = {
		getMarkdownFiles: () => Array.from(tFiles.values()),
		getAbstractFileByPath: (path: string) => tFiles.get(path) ?? null,
		cachedRead: async (file: TFile) => {
			const found = byPath.get(file.path);
			if (!found) throw new Error(`Unknown fake file: ${file.path}`);
			return found.content;
		},
	};

	return { vault } as unknown as App;
}

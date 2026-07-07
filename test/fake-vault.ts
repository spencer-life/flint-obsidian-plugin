import type { App, TFile } from "obsidian";
import { FakeTFile, FakeTFolder } from "./obsidian-mock";

export interface FakeFile {
	path: string;
	content: string;
	frontmatter?: Record<string, unknown>;
}

export interface FakeAppOptions {
	/** Extra (possibly empty) folders to exist in the tree beyond the ones
	 * implied by file paths. */
	folders?: string[];
}

/**
 * Duck-typed `App` stand-in. Implements what src code calls at runtime:
 * `vault.getMarkdownFiles()/getAbstractFileByPath()/getFileByPath()/
 * cachedRead()/read()/create()/process()/getRoot()`, a real folder tree
 * (FakeTFolder) built from file paths + `opts.folders`,
 * `metadataCache.getFileCache()` backed by per-file frontmatter records, and
 * `fileManager.renameFile()/processFrontMatter()`. Files are `FakeTFile`
 * instances (registered via `mock.module`) so `instanceof TFile` passes.
 */
export function createFakeApp(
	files: FakeFile[],
	opts: FakeAppOptions = {},
): App {
	const contents = new Map(files.map((file) => [file.path, file.content]));
	const frontmatters = new Map(
		files.map((file) => [file.path, file.frontmatter ?? {}]),
	);

	const root = new FakeTFolder("/");
	const foldersByPath = new Map<string, FakeTFolder>([["/", root]]);

	const ensureFolder = (path: string): FakeTFolder => {
		if (path === "" || path === "/") return root;
		const existing = foldersByPath.get(path);
		if (existing) return existing;
		const parentPath = path.includes("/")
			? path.slice(0, path.lastIndexOf("/"))
			: "/";
		const parent = ensureFolder(parentPath);
		const folder = new FakeTFolder(path, parent);
		parent.children.push(folder);
		foldersByPath.set(path, folder);
		return folder;
	};

	const tFiles = new Map<string, FakeTFile>();
	const addFile = (path: string): FakeTFile => {
		const parentPath = path.includes("/")
			? path.slice(0, path.lastIndexOf("/"))
			: "/";
		const parent = ensureFolder(parentPath);
		const tFile = new FakeTFile(path, parent);
		parent.children.push(tFile);
		tFiles.set(path, tFile);
		return tFile;
	};

	for (const folder of opts.folders ?? []) ensureFolder(folder);
	for (const file of files) addFile(file.path);

	const removeFromParent = (tFile: FakeTFile) => {
		const parent = foldersByPath.get(tFile.parent?.path ?? "/");
		if (parent) {
			parent.children = parent.children.filter((child) => child !== tFile);
		}
	};

	const vault = {
		getRoot: () => root,
		getMarkdownFiles: () =>
			Array.from(tFiles.values()).filter((file) => file.extension === "md"),
		getAbstractFileByPath: (path: string) =>
			tFiles.get(path) ?? foldersByPath.get(path) ?? null,
		getFileByPath: (path: string) => tFiles.get(path) ?? null,
		cachedRead: async (file: TFile) => {
			const found = contents.get(file.path);
			if (found === undefined)
				throw new Error(`Unknown fake file: ${file.path}`);
			return found;
		},
		read: async (file: TFile) => {
			const found = contents.get(file.path);
			if (found === undefined)
				throw new Error(`Unknown fake file: ${file.path}`);
			return found;
		},
		create: async (path: string, content: string) => {
			if (tFiles.has(path) || foldersByPath.has(path)) {
				throw new Error(`File already exists: ${path}`);
			}
			contents.set(path, content);
			frontmatters.set(path, {});
			return addFile(path);
		},
		process: async (file: TFile, fn: (data: string) => string) => {
			const found = contents.get(file.path);
			if (found === undefined)
				throw new Error(`Unknown fake file: ${file.path}`);
			const next = fn(found);
			contents.set(file.path, next);
			return next;
		},
		modify: async (file: TFile, content: string) => {
			contents.set(file.path, content);
		},
	};

	const fileManager = {
		renameFile: async (file: TFile, newPath: string) => {
			const fake = tFiles.get(file.path);
			if (!fake) throw new Error(`Unknown fake file: ${file.path}`);
			const content = contents.get(file.path) ?? "";
			const fm = frontmatters.get(file.path) ?? {};
			contents.delete(file.path);
			frontmatters.delete(file.path);
			tFiles.delete(file.path);
			removeFromParent(fake);

			const parentPath = newPath.includes("/")
				? newPath.slice(0, newPath.lastIndexOf("/"))
				: "/";
			const parent = ensureFolder(parentPath);
			fake.path = newPath;
			fake.name = newPath.split("/").pop() ?? newPath;
			const dot = fake.name.lastIndexOf(".");
			fake.basename = dot > 0 ? fake.name.slice(0, dot) : fake.name;
			fake.extension = dot > 0 ? fake.name.slice(dot + 1) : "";
			fake.parent = parent;
			parent.children.push(fake);
			tFiles.set(newPath, fake);
			contents.set(newPath, content);
			frontmatters.set(newPath, fm);
		},
		processFrontMatter: async (
			file: TFile,
			fn: (frontmatter: Record<string, unknown>) => void,
		) => {
			const fm = frontmatters.get(file.path) ?? {};
			fn(fm);
			frontmatters.set(file.path, fm);
		},
	};

	const metadataCache = {
		getFileCache: (file: TFile) => {
			const fm = frontmatters.get(file.path);
			if (!fm || Object.keys(fm).length === 0) return {};
			return { frontmatter: fm };
		},
	};

	return { vault, fileManager, metadataCache } as unknown as App;
}

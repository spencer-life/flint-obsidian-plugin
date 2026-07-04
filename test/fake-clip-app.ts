import { FakeTFile } from "./obsidian-mock";

export interface FakeClipFile {
	path: string;
	content: string;
	frontmatter?: Record<string, unknown>;
}

type VaultEventName = "create" | "modify" | "delete" | "rename";
type VaultEventHandler = (...args: unknown[]) => void;

/**
 * Duck-typed `App`/`Plugin` stand-in covering what `src/ingest/watcher.ts`
 * touches at runtime: vault file lookups + events, metadata cache
 * frontmatter, and the frontmatter/rename FileManager calls.
 */
export function createFakeClipApp(files: FakeClipFile[]) {
	const byPath = new Map(files.map((f) => [f.path, f]));
	const listeners: Record<VaultEventName, VaultEventHandler[]> = {
		create: [],
		modify: [],
		delete: [],
		rename: [],
	};

	function toTFile(path: string): FakeTFile {
		const parentPath = path.includes("/")
			? path.slice(0, path.lastIndexOf("/"))
			: "";
		return new FakeTFile(path, { path: parentPath }) as unknown as FakeTFile;
	}

	const vault = {
		getMarkdownFiles: () =>
			Array.from(byPath.keys())
				.filter((path) => path.endsWith(".md"))
				.map((path) => toTFile(path)),
		cachedRead: async (file: { path: string }) => {
			const found = byPath.get(file.path);
			if (!found) throw new Error(`Unknown fake file: ${file.path}`);
			return found.content;
		},
		getAbstractFileByPath: (path: string) =>
			byPath.has(path) ? toTFile(path) : null,
		on: (event: VaultEventName, handler: VaultEventHandler) => {
			listeners[event].push(handler);
			return { event, handler };
		},
	};

	const metadataCache = {
		getFileCache: (file: { path: string }) => {
			const found = byPath.get(file.path);
			return found ? { frontmatter: found.frontmatter } : null;
		},
	};

	const fileManager = {
		processFrontMatter: async (
			file: { path: string },
			fn: (frontmatter: Record<string, unknown>) => void,
		) => {
			const found = byPath.get(file.path);
			if (!found) throw new Error(`Unknown fake file: ${file.path}`);
			found.frontmatter = found.frontmatter ?? {};
			fn(found.frontmatter);
		},
		renameFile: async (file: { path: string }, newPath: string) => {
			const found = byPath.get(file.path);
			if (!found) throw new Error(`Unknown fake file: ${file.path}`);
			byPath.delete(file.path);
			found.path = newPath;
			byPath.set(newPath, found);
			for (const handler of listeners.rename) {
				handler(toTFile(newPath), file.path);
			}
		},
	};

	const app = { vault, metadataCache, fileManager };

	/** Fires a fake vault "create" event, as if a file just landed. */
	function emitCreate(path: string): void {
		const file = toTFile(path);
		for (const handler of listeners.create) handler(file);
	}

	return { app, emitCreate, getFile: (path: string) => byPath.get(path) };
}

/**
 * Minimal `Plugin`-shaped wrapper around `createFakeClipApp` for
 * `ClipWatcher`, which expects `plugin.app`, `plugin.settings`, and
 * `plugin.registerEvent`.
 */
export function createFakeClipPlugin(
	files: FakeClipFile[],
	settings: { clippingsFolder: string },
) {
	const fake = createFakeClipApp(files);
	const registeredEvents: unknown[] = [];

	const plugin = {
		app: fake.app,
		settings,
		registerEvent: (ref: unknown) => {
			registeredEvents.push(ref);
		},
	};

	return { plugin, ...fake, registeredEvents };
}

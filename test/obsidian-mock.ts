import { mock } from "bun:test";

export interface MockRequestUrlParam {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
}

export interface MockRequestUrlResult {
	status?: number;
	json?: unknown;
	text?: string;
}

export type RequestUrlHandler = (
	params: MockRequestUrlParam,
) => MockRequestUrlResult | Promise<MockRequestUrlResult>;

export const requestUrlCalls: MockRequestUrlParam[] = [];

let handler: RequestUrlHandler = () => ({ json: {} });

/** Point the mocked `requestUrl` at a specific response/behavior for a test. */
export function setRequestUrlHandler(next: RequestUrlHandler): void {
	handler = next;
}

/** Clear captured calls and reset to the default handler. Call in `beforeEach`. */
export function resetObsidianMock(): void {
	requestUrlCalls.length = 0;
	handler = () => ({ json: {} });
}

// The real "obsidian" package ships types only (no runtime JS), so it can
// never resolve inside `bun test`. We replace it with a minimal fake exposing
// just what src/*.ts uses at runtime: `requestUrl`, plus enough of the
// `PluginSettingTab`/`Setting` class surface for `settings.ts` (imported for
// its `DEFAULT_SETTINGS` value in pipeline tests) to evaluate without error.
class FakePluginSettingTab {
	app: unknown;
	plugin: unknown;
	constructor(app: unknown, plugin: unknown) {
		this.app = app;
		this.plugin = plugin;
	}
}

class FakeSetting {
	constructor(_containerEl: unknown) {}
	setName() {
		return this;
	}
	setDesc() {
		return this;
	}
	addText() {
		return this;
	}
	addToggle() {
		return this;
	}
	addDropdown() {
		return this;
	}
}

// Minimal stand-ins for TAbstractFile/TFile so `instanceof TFile` checks in
// src/*.ts (e.g. main.ts, ingest/watcher.ts) work against fake vault files.
class FakeTAbstractFile {
	path: string;
	name: string;
	parent: { path: string } | null;

	constructor(path: string, parent: { path: string } | null = null) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.parent = parent;
	}
}

export class FakeTFile extends FakeTAbstractFile {
	basename: string;
	extension: string;

	constructor(path: string, parent: { path: string } | null = null) {
		super(path, parent);
		const name = this.name;
		const dot = name.lastIndexOf(".");
		this.basename = dot > 0 ? name.slice(0, dot) : name;
		this.extension = dot > 0 ? name.slice(dot + 1) : "";
	}
}

/** Simplified port of Obsidian's `normalizePath`: backslashes to slashes,
 * collapsed repeated slashes, no trailing slash, no leading "./". */
function fakeNormalizePath(path: string): string {
	let result = path.replace(/\\/g, "/").replace(/\/+/g, "/");
	if (result.startsWith("./")) result = result.slice(2);
	if (result.length > 1 && result.endsWith("/")) result = result.slice(0, -1);
	return result;
}

/** Debounce mock matching Obsidian's `(cb, timeout, resetTimer)` shape closely
 * enough for tests: trailing-edge call after `timeout` ms of inactivity. */
function fakeDebounce<T extends unknown[]>(
	cb: (...args: T) => unknown,
	timeout = 0,
	resetTimer = false,
): ((...args: T) => void) & { cancel: () => void; run: () => void } {
	let handle: ReturnType<typeof setTimeout> | undefined;
	let lastArgs: T | undefined;

	const invoke = () => {
		handle = undefined;
		if (lastArgs) cb(...lastArgs);
	};

	const debounced = (...args: T) => {
		lastArgs = args;
		if (handle && !resetTimer) return;
		if (handle) clearTimeout(handle);
		handle = setTimeout(invoke, timeout);
	};

	debounced.cancel = () => {
		if (handle) clearTimeout(handle);
		handle = undefined;
	};
	debounced.run = () => {
		if (handle) clearTimeout(handle);
		invoke();
	};

	return debounced;
}

mock.module("obsidian", () => ({
	requestUrl: async (params: MockRequestUrlParam) => {
		requestUrlCalls.push(params);
		const result = await handler(params);
		if ((result.status ?? 200) >= 400) {
			throw new Error(`Request failed, status ${result.status}`);
		}
		return {
			status: result.status ?? 200,
			headers: {},
			json: result.json,
			text: result.text ?? "",
			arrayBuffer: new ArrayBuffer(0),
		};
	},
	PluginSettingTab: FakePluginSettingTab,
	Setting: FakeSetting,
	TAbstractFile: FakeTAbstractFile,
	TFile: FakeTFile,
	normalizePath: fakeNormalizePath,
	debounce: fakeDebounce,
	Notice: class FakeNotice {
		constructor(_message?: string) {}
	},
}));

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
}));

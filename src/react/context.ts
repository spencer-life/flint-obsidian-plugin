import type { App } from "obsidian";
import { createContext, useContext } from "react";
import type FlintPlugin from "../main";

export interface FlintContextValue {
	app: App;
	plugin: FlintPlugin;
}

export const FlintContext = createContext<FlintContextValue | null>(null);

function useFlintContext(): FlintContextValue {
	const ctx = useContext(FlintContext);
	if (!ctx) {
		throw new Error(
			"Flint React components must be rendered within FlintContext.Provider",
		);
	}
	return ctx;
}

export function useApp(): App {
	return useFlintContext().app;
}

export function usePlugin(): FlintPlugin {
	return useFlintContext().plugin;
}

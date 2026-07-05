import { AbstractInputSuggest, type App } from "obsidian";

/**
 * Scrollable, keyboard-navigable model-id picker backed by Obsidian's
 * `AbstractInputSuggest` (the same popover folder/file pickers use),
 * replacing the native `<input list>` + `<datalist>` combo. Electron's
 * datalist popup has a fixed height with no scroll support (wheel or
 * keyboard), so with hundreds of models users could only ever see the
 * first ~20.
 *
 * An empty query returns every model — the "browse" case the datalist
 * couldn't do, since its native popover only ever appears already
 * scrolled to the top with no way to reach the rest.
 */
export class ModelSuggest extends AbstractInputSuggest<string> {
	private readonly getModels: () => string[];

	constructor(
		app: App,
		inputEl: HTMLInputElement,
		getModels: () => string[],
		onPick: (value: string) => void,
	) {
		super(app, inputEl);
		this.getModels = getModels;
		// No render cap — the popover scrolls natively, and that's the whole
		// point of this replacement (see file doc comment above).
		this.limit = 0;
		this.onSelect((value, evt) => {
			evt.preventDefault();
			this.setValue(value);
			onPick(value);
			this.close();
		});
	}

	getSuggestions(query: string): string[] {
		const models = this.getModels();
		if (!query) return models;
		const needle = query.toLowerCase();
		return models.filter((id) => id.toLowerCase().includes(needle));
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}
}

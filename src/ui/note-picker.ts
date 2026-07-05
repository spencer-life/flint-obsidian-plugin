import { type App, FuzzySuggestModal, type TFile } from "obsidian";

/**
 * Fuzzy note picker for attaching vault notes as chat references, built on
 * Obsidian's own `FuzzySuggestModal` (the same widget the quick-switcher
 * uses). Lists every markdown file minus whatever's already attached, and
 * hands the chosen `TFile` back via `onChoose`.
 */
export class NotePickerModal extends FuzzySuggestModal<TFile> {
	private readonly files: TFile[];
	private readonly onChoose: (file: TFile) => void;

	constructor(
		app: App,
		excludePaths: string[],
		onChoose: (file: TFile) => void,
	) {
		super(app);
		const excluded = new Set(excludePaths);
		this.files = app.vault
			.getMarkdownFiles()
			.filter((file) => !excluded.has(file.path));
		this.onChoose = onChoose;
		this.setPlaceholder("Attach a note as a reference…");
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

import { Notice } from "obsidian";
import { useMemo } from "react";
import { isWithinFolder } from "../ingest/clip-processor";
import { isOrganized } from "../triage/organize";
import { useApp, usePlugin } from "./context";
import {
	computeSuggestions,
	type Suggestion,
	type VaultSnapshot,
} from "./suggestion-signals";

/** How many recently modified notes feed the top-tag probe. */
const RECENT_NOTE_COUNT = 20;

/**
 * Empty-state suggestion cards, computed once per mount from cheap local
 * signals (file list + metadata cache — no LLM, no reads).
 */
export function Suggestions({ onSeed }: { onSeed: (text: string) => void }) {
	const app = useApp();
	const plugin = usePlugin();

	const suggestions = useMemo(() => {
		const captureFolder = plugin.settings.captureFolder;
		const files = app.vault.getMarkdownFiles();

		let unfiledCount = 0;
		let pendingSuggestionCount = 0;
		for (const file of files) {
			if (!isWithinFolder(file.path, captureFolder)) continue;
			const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
			if (!isOrganized(frontmatter)) {
				unfiledCount += 1;
			} else if (typeof frontmatter?.["flint-suggest-dest"] === "string") {
				pendingSuggestionCount += 1;
			}
		}

		const tagCounts = new Map<string, number>();
		const recent = [...files]
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, RECENT_NOTE_COUNT);
		for (const file of recent) {
			const cache = app.metadataCache.getFileCache(file);
			const frontTags = cache?.frontmatter?.["tags"];
			const fromFrontmatter = Array.isArray(frontTags)
				? frontTags.filter((tag): tag is string => typeof tag === "string")
				: [];
			const fromBody = (cache?.tags ?? []).map((entry) =>
				entry.tag.replace(/^#/, ""),
			);
			for (const tag of [...fromFrontmatter, ...fromBody]) {
				tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			}
		}
		let topRecentTag: string | undefined;
		let best = 1; // Require at least 2 mentions to call it a "topic".
		for (const [tag, count] of tagCounts) {
			if (count > best) {
				best = count;
				topRecentTag = tag;
			}
		}

		const snapshot: VaultSnapshot = {
			unfiledCount,
			pendingSuggestionCount,
			topRecentTag,
		};
		return computeSuggestions(snapshot);
		// Computed once per mount by design — signals don't need to be live.
	}, [app, plugin]);

	const activate = (suggestion: Suggestion) => {
		switch (suggestion.action.kind) {
			case "organize":
				new Notice("Flint: organizing the capture backlog…");
				void plugin.organizeService.scanBacklog();
				break;
			case "review":
				void plugin.organizeService.runBulkReview();
				break;
			case "seed":
				onSeed(suggestion.action.text);
				break;
		}
	};

	return (
		<div className="flint-suggestions">
			{suggestions.map((suggestion) => (
				<button
					type="button"
					key={suggestion.id}
					className="flint-suggestion-card"
					onClick={() => activate(suggestion)}
				>
					<div className="flint-suggestion-title">{suggestion.title}</div>
					<div className="flint-suggestion-desc">{suggestion.description}</div>
				</button>
			))}
		</div>
	);
}

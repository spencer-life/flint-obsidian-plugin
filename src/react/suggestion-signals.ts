/**
 * Pure signal → suggestion-card logic for the panel's empty state. No LLM
 * calls, no `obsidian` imports — the caller snapshots the vault cheaply on
 * mount and this decides which 3-4 cards earn the space.
 */

export interface VaultSnapshot {
	/** Capture-folder notes with no `flint-organized` marker yet. */
	unfiledCount: number;
	/** Capture-folder notes with pending (organized-but-unapplied) suggestions. */
	pendingSuggestionCount: number;
	/** Most frequent tag across recently modified notes, without the `#`. */
	topRecentTag?: string;
}

export type SuggestionAction =
	| { kind: "organize" }
	| { kind: "review" }
	| { kind: "seed"; text: string };

export interface Suggestion {
	id: string;
	title: string;
	description: string;
	action: SuggestionAction;
}

const MAX_SUGGESTIONS = 4;

export function computeSuggestions(snapshot: VaultSnapshot): Suggestion[] {
	const suggestions: Suggestion[] = [];

	if (snapshot.unfiledCount > 0) {
		suggestions.push({
			id: "organize-backlog",
			title: `Organize ${snapshot.unfiledCount} unfiled ${snapshot.unfiledCount === 1 ? "capture" : "captures"}`,
			description: "Suggest titles, tags, and folders for what's waiting.",
			action: { kind: "organize" },
		});
	}

	if (snapshot.pendingSuggestionCount > 0) {
		suggestions.push({
			id: "review-suggestions",
			title: `Review ${snapshot.pendingSuggestionCount} filing ${snapshot.pendingSuggestionCount === 1 ? "suggestion" : "suggestions"}`,
			description: "Approve or skip each proposed move.",
			action: { kind: "review" },
		});
	}

	suggestions.push({
		id: "yesterday",
		title: "What did I capture yesterday?",
		description: "A quick recap of your latest additions.",
		action: { kind: "seed", text: "What did I capture yesterday?" },
	});

	if (snapshot.topRecentTag) {
		suggestions.push({
			id: "top-tag",
			title: `Catch me up on #${snapshot.topRecentTag}`,
			description: "Your most active recent topic.",
			action: {
				kind: "seed",
				text: `Summarize my recent notes about ${snapshot.topRecentTag}.`,
			},
		});
	}

	if (suggestions.length < 3) {
		suggestions.push({
			id: "week",
			title: "What's on my plate this week?",
			description: "Pull open tasks and active projects together.",
			action: { kind: "seed", text: "What's on my plate this week?" },
		});
	}
	if (suggestions.length < 3) {
		suggestions.push({
			id: "explore",
			title: "Find connections in my vault",
			description: "Surface related notes you might have forgotten.",
			action: {
				kind: "seed",
				text: "Find interesting connections between my recent notes.",
			},
		});
	}

	return suggestions.slice(0, MAX_SUGGESTIONS);
}

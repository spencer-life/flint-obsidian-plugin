import type { ChatMessage } from "../providers/types";

/** A discovered project tracker the LLM can route an item to. */
export interface TriageTracker {
	/** Vault path, e.g. "01 Projects/Website Relaunch.md". */
	path: string;
	/** Basename without extension, e.g. "Website Relaunch". */
	name: string;
}

const SYSTEM_PROMPT =
	"You are Flint, a triage assistant for an ADHD capture inbox inside an " +
	"Obsidian vault. You will be given a list of raw capture bullets and a " +
	"list of active project trackers. For EACH item, decide which single " +
	"tracker it belongs to, or 'ideas' if it's a standalone idea with no " +
	"project yet, or 'unsorted' if you genuinely can't tell. Also draft one " +
	"tiny, concrete next physical action (12 words or fewer) that would move " +
	"the item forward.\n\n" +
	"Respond with ONLY a strict JSON array, no prose, no markdown fences, in " +
	'this exact shape: [{"item": "<original item text>", "target": "<tracker ' +
	'path>|ideas|unsorted", "nextStep": "<tiny next action>"}]. Return exactly ' +
	"one entry per input item, in the same order.";

/**
 * Builds the (system, user) messages for a single batched triage
 * classification call. Pure and unit-testable — no network/provider calls
 * here.
 */
export function buildTriagePrompt(
	items: string[],
	trackers: TriageTracker[],
): ChatMessage[] {
	const trackerList =
		trackers.length > 0
			? trackers
					.map((tracker) => `- ${tracker.path} (${tracker.name})`)
					.join("\n")
			: "(no active project trackers found — use 'ideas' or 'unsorted')";

	const itemList = items.map((item, i) => `${i + 1}. ${item}`).join("\n");

	const userPrompt =
		`Project trackers:\n${trackerList}\n\n` +
		`Inbox items to triage:\n${itemList}`;

	return [
		{ role: "system", content: SYSTEM_PROMPT },
		{ role: "user", content: userPrompt },
	];
}

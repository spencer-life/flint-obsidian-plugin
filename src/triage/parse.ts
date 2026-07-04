/**
 * Pure logic for the ADHD Capture Triage flow. No `obsidian` imports here so
 * this module stays unit-testable without the Obsidian runtime.
 */

/** One capture bullet extracted from an inbox note. */
export interface InboxBullet {
	/** The exact source line (used later to remove it verbatim). */
	raw: string;
	/** The bullet's content with any QuickAdd timestamp prefix stripped. */
	item: string;
}

/** A single routing decision the LLM returned for one inbox item. */
export interface TriageClassification {
	item: string;
	target: string;
	nextStep: string;
}

// QuickAdd-style capture: "- 2026-07-04 14:22 — buy a domain for X" or
// "- 2026-07-04 14:22 - buy a domain for X". The timestamp prefix is optional
// so a plain "- buy a domain for X" bullet is also recognized.
const BULLET_PATTERN =
	/^-\s+(?:\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[—-]\s+)?(.+)$/;

// Task lines ("- [ ] ..." / "- [x] ...") are routed output, not raw capture —
// never re-triage them.
const TASK_LINE_PATTERN = /^-\s*\[[ xX]\]/;

/**
 * Extracts plain capture bullets from an inbox note's markdown, skipping
 * headings, blank lines, and already-routed task lines (`- [ ]`).
 */
export function extractBullets(content: string): InboxBullet[] {
	const bullets: InboxBullet[] = [];

	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (TASK_LINE_PATTERN.test(trimmed)) continue;

		const match = trimmed.match(BULLET_PATTERN);
		if (!match?.[1]) continue;

		const item = match[1].trim();
		if (item.length === 0) continue;

		bullets.push({ raw: line, item });
	}

	return bullets;
}

const JSON_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Defensively parses the LLM's classification response: strips a ```json
 * fence if present, then validates the parsed value is an array of
 * `{item, target, nextStep}` objects. Throws a descriptive `Error` on any
 * unparseable/malformed input — callers must never write garbage to the vault.
 */
export function parseTriageResponse(raw: string): TriageClassification[] {
	const fenced = raw.match(JSON_FENCE_PATTERN);
	const candidate = (fenced?.[1] ?? raw).trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		throw new Error(
			"Flint: the AI's triage response wasn't valid JSON — aborting without writing changes.",
		);
	}

	if (!Array.isArray(parsed)) {
		throw new Error(
			"Flint: the AI's triage response wasn't a JSON array — aborting without writing changes.",
		);
	}

	const classifications: TriageClassification[] = [];
	for (const entry of parsed) {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as Record<string, unknown>)["item"] !== "string" ||
			typeof (entry as Record<string, unknown>)["target"] !== "string" ||
			typeof (entry as Record<string, unknown>)["nextStep"] !== "string"
		) {
			throw new Error(
				"Flint: the AI's triage response had a malformed entry — aborting without writing changes.",
			);
		}
		const item = entry as Record<string, string>;
		classifications.push({
			item: item["item"] as string,
			target: item["target"] as string,
			nextStep: item["nextStep"] as string,
		});
	}

	return classifications;
}

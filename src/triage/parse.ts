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

/** Hard cap on a routed `nextStep`'s length once it's appended as a task
 * line in a tracker note. */
export const NEXT_STEP_MAX_LENGTH = 200;

// A leading Markdown structural token (heading, list item, blockquote, task
// checkbox) that — left unescaped — would reopen a new block when the
// nextStep is appended as a line under "## Next small steps".
const LEADING_MARKDOWN_STRUCTURE = /^(\s*)(#{1,6}|[-*>]|\[[ xX]?\])/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point here.
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Sanitizes a single classification's `nextStep` before it's ever appended
 * to a tracker note: retrieved web/vault text an attacker controls can be
 * prompt-injected into the LLM's JSON reply, so `nextStep` can't be trusted
 * to be a single plain line. Collapses newlines/control characters to
 * spaces, escapes a leading Markdown-structural token so it can't reopen a
 * heading/list/blockquote/checkbox, and caps the length.
 */
export function sanitizeNextStep(nextStep: string): string {
	let sanitized = nextStep
		.split(/\r\n|\r|\n/)
		.join(" ")
		.replace(CONTROL_CHAR_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim();

	sanitized = sanitized.replace(
		LEADING_MARKDOWN_STRUCTURE,
		(_match, ws: string, token: string) => `${ws}\\${token}`,
	);

	if (sanitized.length > NEXT_STEP_MAX_LENGTH) {
		sanitized = sanitized.slice(0, NEXT_STEP_MAX_LENGTH).trim();
	}

	return sanitized;
}

const JSON_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Defensively parses the LLM's classification response: strips a ```json
 * fence if present, then validates the parsed value is an array of
 * `{item, target, nextStep}` objects. Throws a descriptive `Error` on any
 * unparseable/malformed input — callers must never write garbage to the vault.
 * Each entry's `nextStep` is sanitized (see `sanitizeNextStep`) before being
 * returned, since it's untrusted LLM output derived from retrieved content.
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
			nextStep: sanitizeNextStep(item["nextStep"] as string),
		});
	}

	return classifications;
}

/**
 * Validates a parsed classification batch against the source bullets it's
 * meant to answer, POSITIONALLY: the batch must be exactly as long as
 * `sourcedItems`, and each entry's `item` must trim-match the source bullet
 * at the same index. There's no stable id on a classification to pair it
 * against a source bullet by — only the `item` text — so a missing,
 * duplicated, reordered, or shifted model entry can't be told apart from a
 * trustworthy one once you start pairing by array position alone. Rejecting
 * the WHOLE batch on any mismatch (instead of best-effort pairing, which is
 * what silently sent next-steps to the wrong project and deleted the wrong
 * inbox bullet) is the only safe response. Throws a descriptive `Error` on
 * any mismatch — callers must never write garbage to the vault.
 */
export function validateTriageBatch(
	classifications: TriageClassification[],
	sourcedItems: string[],
): void {
	if (classifications.length !== sourcedItems.length) {
		throw new Error(
			`Flint: the AI's triage response returned ${classifications.length} item(s) for ${sourcedItems.length} inbox bullet(s) — rejecting the batch without writing changes.`,
		);
	}

	for (let i = 0; i < classifications.length; i++) {
		const expected = sourcedItems[i];
		const actual = classifications[i];
		if (
			expected === undefined ||
			actual === undefined ||
			actual.item.trim() !== expected.trim()
		) {
			throw new Error(
				"Flint: the AI's triage response was mismatched or out of order — rejecting the batch without writing changes.",
			);
		}
	}
}

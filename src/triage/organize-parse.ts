/**
 * Pure logic for the auto-organize flow: parsing the LLM's filing suggestion
 * and sanitizing/validating each field before it's ever written to the vault.
 * No `obsidian` imports here so this module stays unit-testable without the
 * Obsidian runtime.
 *
 * The capture note's content is untrusted (a prompt-injection surface): the
 * LLM's JSON reply is treated purely as data. Structural garbage throws
 * (nothing gets written); a destination that isn't an exact match against the
 * caller-supplied allowlist of real, existing vault folders is silently
 * dropped rather than trusted — title/tag suggestions still stand.
 */

/** A single organize suggestion for one capture note. `destination` is
 * `null` when the LLM didn't suggest one, or suggested one that isn't an
 * exact match in the allowlist (rejected, never trusted). */
export interface OrganizeSuggestion {
	title: string;
	tags: string[];
	destination: string | null;
}

const JSON_FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/i;

/** Hard cap on a suggested title's length once it's written as frontmatter
 * (and, on apply, used as a filename base). */
export const MAX_TITLE_LENGTH = 180;

/** Hard cap on how many tags a single suggestion can carry. */
export const MAX_TAGS = 8;

const WINDOWS_UNSAFE_CHARS = /[\\/:*?"<>|]/g;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point here.
const CONTROL_CHAR_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const TAG_DISALLOWED_CHARS = /[^a-z0-9/_-]/g;

/**
 * Sanitizes a suggested title: strips control characters and path
 * separators/other Windows-unsafe characters (it may later become a
 * filename), collapses whitespace, and caps the length.
 */
export function sanitizeOrganizeTitle(title: string): string {
	const cleaned = title
		.replace(CONTROL_CHAR_PATTERN, "")
		.replace(WINDOWS_UNSAFE_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TITLE_LENGTH)
		.trim();
	return cleaned.length > 0 ? cleaned : "Untitled capture";
}

/**
 * Sanitizes a suggested tag list: lowercases, restricts every tag to
 * `[a-z0-9/_-]`, drops anything that becomes empty or a duplicate, and caps
 * the count. Non-array/non-string input yields an empty list rather than
 * throwing — tags are optional.
 */
export function sanitizeOrganizeTags(tags: unknown): string[] {
	if (!Array.isArray(tags)) return [];

	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of tags) {
		if (typeof raw !== "string") continue;
		const cleaned = raw.toLowerCase().replace(TAG_DISALLOWED_CHARS, "").trim();
		if (cleaned.length === 0 || seen.has(cleaned)) continue;
		seen.add(cleaned);
		result.push(cleaned);
		if (result.length >= MAX_TAGS) break;
	}
	return result;
}

/**
 * Validates an LLM-suggested destination against `allowedDestinations` — a
 * caller-computed allowlist of real, existing vault folder paths. This is
 * the safety boundary: an LLM-emitted path (from a capture whose content is
 * untrusted, and can therefore try to prompt-inject a move to somewhere like
 * "../../etc") is NEVER trusted directly. Only an exact string match against
 * the allowlist is accepted; anything else resolves to `null` (no
 * destination suggested — the file simply stays put).
 */
export function resolveOrganizeDestination(
	destination: unknown,
	allowedDestinations: string[],
): string | null {
	if (typeof destination !== "string") return null;
	const trimmed = destination.trim();
	if (trimmed.length === 0) return null;
	return allowedDestinations.includes(trimmed) ? trimmed : null;
}

/**
 * Defensively parses the LLM's organize response: strips a ```json fence if
 * present, then validates the parsed value is a `{title, tags?, destination?}`
 * object. Throws a descriptive `Error` on any unparseable/structurally
 * malformed input — callers must never write garbage to the vault. `tags`
 * and `destination` are sanitized/validated (see above) rather than causing a
 * throw, since a missing/bad tag list or an out-of-allowlist destination is
 * an expected, safely-degradable case, not a structural failure.
 */
/**
 * One activity-log line for a single applied organize move. `newPath` becomes
 * a wikilink (extension stripped) so the log entry stays clickable even
 * though the note has left the capture folder; the old path is kept as
 * inline code — it no longer exists, so a link would be dead.
 */
export function buildOrganizeLogLine(
	oldPath: string,
	newPath: string,
	timestamp: string,
): string {
	const linkTarget = newPath.replace(/\.md$/i, "");
	return `- ${timestamp} — [[${linkTarget}]] ← was \`${oldPath}\``;
}

export function parseOrganizeResponse(
	raw: string,
	allowedDestinations: string[],
): OrganizeSuggestion {
	const fenced = raw.match(JSON_FENCE_PATTERN);
	const candidate = (fenced?.[1] ?? raw).trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		throw new Error(
			"Flint: the AI's organize response wasn't valid JSON — aborting without writing changes.",
		);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(
			"Flint: the AI's organize response wasn't a JSON object — aborting without writing changes.",
		);
	}

	const obj = parsed as Record<string, unknown>;
	if (typeof obj["title"] !== "string") {
		throw new Error(
			"Flint: the AI's organize response was missing a string title — aborting without writing changes.",
		);
	}

	return {
		title: sanitizeOrganizeTitle(obj["title"]),
		tags: sanitizeOrganizeTags(obj["tags"]),
		destination: resolveOrganizeDestination(
			obj["destination"],
			allowedDestinations,
		),
	};
}

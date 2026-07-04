/**
 * Pure logic for tidying/stamping web clips. No `obsidian` imports here so
 * this module stays unit-testable without the Obsidian runtime.
 */

/** Value written to `frontmatter.flint` once a clip has been processed. Also
 * the idempotency marker: its presence means "don't reprocess this file". */
export const FLINT_PROCESSED_MARKER = "processed";

const URL_PATTERN = /^https?:\/\/\S+$/i;

/** Frontmatter keys (in priority order) that might already hold the clip's
 * source URL, depending on which web clipper produced the file. */
const SOURCE_URL_KEYS = ["source", "url", "Source URL", "source_url"];

const WINDOWS_UNSAFE_CHARS = /[\\/:*?"<>|]/g;

/** Generic/placeholder basenames web clippers commonly emit. */
const EGREGIOUS_NAME_PATTERN =
	/^(untitled|clipping|new clipping|new note|clip|clip \d+)\s*\d*$/i;

const MAX_FILENAME_LENGTH = 180;

/** True when a clip's frontmatter already carries the Flint processed marker. */
export function isClipProcessed(
	frontmatter: Record<string, unknown> | null | undefined,
): boolean {
	return frontmatter?.["flint"] === FLINT_PROCESSED_MARKER;
}

/**
 * Whether a vault path should be considered for clip processing: it must sit
 * inside `clippingsFolder` and lack the idempotency marker.
 */
export function needsProcessing(
	path: string,
	clippingsFolder: string,
	frontmatter: Record<string, unknown> | null | undefined,
): boolean {
	if (!path.toLowerCase().endsWith(".md")) return false;
	if (!isWithinFolder(path, clippingsFolder)) return false;
	return !isClipProcessed(frontmatter);
}

export function isWithinFolder(path: string, folder: string): boolean {
	const normalized = folder.endsWith("/") ? folder.slice(0, -1) : folder;
	if (normalized.length === 0) return true;
	return path === normalized || path.startsWith(`${normalized}/`);
}

/**
 * Mutates a live frontmatter object (as handed in by
 * `FileManager.processFrontMatter`) to ensure `clipped`, `source` (when
 * known), and the `flint: processed` marker are present. Existing values are
 * left untouched. Returns whether anything changed.
 */
export function stampClipFrontmatter(
	frontmatter: Record<string, unknown>,
	opts: { now: Date; sourceUrl?: string },
): boolean {
	let changed = false;

	if (
		typeof frontmatter["clipped"] !== "string" ||
		frontmatter["clipped"].length === 0
	) {
		frontmatter["clipped"] = opts.now.toISOString();
		changed = true;
	}

	if (opts.sourceUrl && !frontmatter["source"]) {
		frontmatter["source"] = opts.sourceUrl;
		changed = true;
	}

	if (frontmatter["flint"] !== FLINT_PROCESSED_MARKER) {
		frontmatter["flint"] = FLINT_PROCESSED_MARKER;
		changed = true;
	}

	return changed;
}

/** Look for an already-present source URL under whichever key a given web
 * clipper used, so we don't clobber it and don't fabricate a duplicate. */
export function extractSourceUrl(
	frontmatter: Record<string, unknown> | null | undefined,
): string | undefined {
	if (!frontmatter) return undefined;
	for (const key of SOURCE_URL_KEYS) {
		const value = frontmatter[key];
		if (typeof value === "string" && URL_PATTERN.test(value.trim())) {
			return value.trim();
		}
	}
	return undefined;
}

const FRONTMATTER_BLOCK_PATTERN = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/;

/** Pulls the first Markdown H1 out of the note body (frontmatter block, if
 * any, is skipped) — used as a fallback title source when renaming. */
export function extractFirstHeading(content: string): string | undefined {
	const withoutFrontmatter = content.replace(FRONTMATTER_BLOCK_PATTERN, "");
	const match = withoutFrontmatter.match(/^#\s+(.+)$/m);
	return match?.[1]?.trim();
}

/**
 * Splits note content into its raw frontmatter block (including the `---`
 * fences, or `""` if there isn't one) and the body below it. Used by the
 * refetch command to replace only the body while leaving frontmatter intact.
 */
export function splitFrontmatterBlock(content: string): {
	frontmatterBlock: string;
	body: string;
} {
	const match = content.match(FRONTMATTER_BLOCK_PATTERN);
	if (!match?.[1]) return { frontmatterBlock: "", body: content };
	return { frontmatterBlock: match[1], body: content.slice(match[1].length) };
}

/** Sanitizes a title into a Windows-safe filename base (no extension). */
export function sanitizeFilenameBase(name: string): string {
	const cleaned = name
		.replace(WINDOWS_UNSAFE_CHARS, "-")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_FILENAME_LENGTH)
		.trim();
	return cleaned.length > 0 ? cleaned : "Untitled clip";
}

/**
 * Decides whether a clip's current filename is "egregious" enough to
 * normalize (generic placeholder name, unsafe characters, or absurd length)
 * and, if so, returns a sanitized replacement built from `title`. Returns
 * `null` when no rename is warranted.
 */
export function suggestFilename(
	currentBasename: string,
	title: string | undefined,
): string | null {
	const trimmed = currentBasename.trim();
	const isEgregious =
		EGREGIOUS_NAME_PATTERN.test(trimmed) ||
		WINDOWS_UNSAFE_CHARS.test(trimmed) ||
		trimmed.length > MAX_FILENAME_LENGTH + 20;

	if (!isEgregious) return null;
	if (!title || title.trim().length === 0) return null;

	const sanitized = sanitizeFilenameBase(title);
	if (sanitized.length === 0) return null;
	if (sanitized.toLowerCase() === trimmed.toLowerCase()) return null;
	return sanitized;
}

/**
 * Pure string transforms applied inside `Vault.process()` for the triage
 * flow: appending routed tasks under a heading, and removing the inbox
 * bullets that were just routed. No `obsidian` imports here so this module
 * stays unit-testable without the Obsidian runtime.
 */

export const NEXT_STEPS_HEADING = "## 👉 Next small steps";

/**
 * Appends `lines` as list items under `heading` in `content`. If the heading
 * already exists, the lines are inserted at the end of that section (right
 * before the next heading, or at EOF if it's the last section). If the
 * heading is missing, it's created (with a blank-line separator) at EOF.
 */
export function appendUnderHeading(
	content: string,
	heading: string,
	lines: string[],
): string {
	if (lines.length === 0) return content;

	const bodyLines = content.split(/\r?\n/);
	const headingIndex = bodyLines.findIndex((line) => line.trim() === heading);

	if (headingIndex === -1) {
		const trimmedContent = content.replace(/\s+$/, "");
		const prefix = trimmedContent.length > 0 ? `${trimmedContent}\n\n` : "";
		return `${prefix}${heading}\n${lines.join("\n")}\n`;
	}

	// Find the end of this heading's section: the next line that starts a new
	// heading (`#`), or EOF.
	let insertAt = bodyLines.length;
	for (let i = headingIndex + 1; i < bodyLines.length; i++) {
		if (/^#{1,6}\s/.test(bodyLines[i] ?? "")) {
			insertAt = i;
			break;
		}
	}

	// Trim trailing blank lines within the section so appended items sit
	// directly after existing content, then re-add a single separating blank
	// line if there's a following section.
	while (
		insertAt > headingIndex + 1 &&
		(bodyLines[insertAt - 1] ?? "").trim() === ""
	) {
		insertAt--;
	}

	const before = bodyLines.slice(0, insertAt);
	const after = bodyLines.slice(insertAt);
	const hasTrailingSection = after.length > 0;

	const inserted = [...before, ...lines];
	if (hasTrailingSection) inserted.push("");
	inserted.push(...after);

	return inserted.join("\n");
}

/**
 * Removes the given raw lines (exact string matches, e.g. `InboxBullet.raw`)
 * from `content`, preserving every other line untouched.
 */
export function removeBullets(content: string, rawLines: string[]): string {
	if (rawLines.length === 0) return content;

	const toRemove = new Set(rawLines);
	const usesCRLF = content.includes("\r\n");
	const lines = content.split(/\r?\n/).filter((line) => !toRemove.has(line));
	return lines.join(usesCRLF ? "\r\n" : "\n");
}

/**
 * Pure logic for the "Generate HTML page from note" command: the prompt
 * builder, defensive reply-fence stripping, and filename collision
 * suffixing. No `obsidian` imports here so this module stays unit-testable
 * without the Obsidian runtime.
 */

import type { ChatMessage } from "../providers/types";

/**
 * Builds the chat messages sent to the active provider asking it to turn a
 * note into a single self-contained HTML document (inline CSS, no external
 * resources, readable typography).
 */
export function buildHtmlPagePrompt(
	title: string,
	noteContent: string,
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"You turn Markdown notes into a single self-contained HTML document. " +
				"Output ONLY the HTML — no explanations, no Markdown code fences. " +
				"Requirements: a complete <!DOCTYPE html> document with <head> and <body>; " +
				"all CSS inline in a <style> tag in the <head> (no external stylesheets, " +
				"fonts, scripts, or images); readable typography (comfortable line length, " +
				"font sizing, spacing); the note's title as the page <title> and a top-level " +
				"heading; the note's content rendered as clean semantic HTML.",
		},
		{
			role: "user",
			content: `Note title: ${title}\n\nNote content:\n\n${noteContent}`,
		},
	];
}

const FENCE_PATTERN = /^```[ \t]*[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Strips a defensive layer of Markdown code fencing a provider might wrap
 * its HTML reply in (```html ... ```, bare ``` ... ```, or no fence at all),
 * plus surrounding whitespace. Only strips a fence that wraps the *entire*
 * reply — fences appearing mid-document (e.g. inside a <pre> the model
 * generated) are left untouched.
 */
export function stripReplyFences(reply: string): string {
	const trimmed = reply.trim();
	const match = trimmed.match(FENCE_PATTERN);
	return match ? (match[1] ?? "").trim() : trimmed;
}

/**
 * Given a desired vault path and an `exists` check, returns the first
 * available path — the desired path itself if free, otherwise the same path
 * with " (2)", " (3)", ... inserted before the extension. Never overwrites.
 */
export function nextAvailablePath(
	desiredPath: string,
	exists: (path: string) => boolean,
): string {
	if (!exists(desiredPath)) return desiredPath;

	const lastSlash = desiredPath.lastIndexOf("/");
	const dir = lastSlash === -1 ? "" : desiredPath.slice(0, lastSlash + 1);
	const name =
		lastSlash === -1 ? desiredPath : desiredPath.slice(lastSlash + 1);

	const lastDot = name.lastIndexOf(".");
	const base = lastDot > 0 ? name.slice(0, lastDot) : name;
	const ext = lastDot > 0 ? name.slice(lastDot) : "";

	let n = 2;
	let candidate = `${dir}${base} (${n})${ext}`;
	while (exists(candidate)) {
		n++;
		candidate = `${dir}${base} (${n})${ext}`;
	}
	return candidate;
}

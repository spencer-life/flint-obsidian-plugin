/**
 * Pure logic for the "Generate HTML page from note" command: the prompt
 * builder, defensive reply-fence stripping, HTML sanitization, and filename
 * collision suffixing. No `obsidian` imports here so this module stays
 * unit-testable without the Obsidian runtime.
 */

import createDOMPurify from "dompurify";
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
 * Window-like object DOMPurify needs to operate. In the Obsidian runtime
 * (Electron on desktop, a WebView on mobile) a real `window` is always
 * present; tests inject a jsdom window instead so this stays unit-testable
 * without the Obsidian runtime.
 */
type PurifyWindow = Parameters<typeof createDOMPurify>[0];

/** Restrictive CSP injected into every generated document's `<head>`: no
 * network-loaded resources at all (scripts, styles, frames, remote images),
 * only inline styles and `data:` images/fonts — matching the "single
 * self-contained HTML document" contract we ask the model for. */
const CSP_META_TAG =
	"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:\">";

/** Common inline event-handler attributes. DOMPurify already strips `on*`
 * attributes by default; this list is explicit defense-in-depth per the
 * security review. */
const FORBIDDEN_EVENT_ATTRS = [
	"onabort",
	"onafterprint",
	"onbeforeprint",
	"onbeforeunload",
	"onblur",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"oncontextmenu",
	"oncopy",
	"oncuechange",
	"oncut",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onhashchange",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmessage",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onoffline",
	"ononline",
	"onpagehide",
	"onpageshow",
	"onpaste",
	"onpause",
	"onplay",
	"onplaying",
	"onpopstate",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsearch",
	"onseeked",
	"onseeking",
	"onselect",
	"onstalled",
	"onstorage",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onunload",
	"onvolumechange",
	"onwaiting",
	"onwheel",
];

const HEAD_OPEN_PATTERN = /<head[^>]*>/i;
const HTML_OPEN_PATTERN = /<html[^>]*>/i;

/** Inserts the CSP `<meta>` as the first child of `<head>`, creating a
 * `<head>` (inside `<html>`, or at the document's start as a last resort) if
 * the sanitized document doesn't have one. */
function injectCsp(html: string): string {
	if (HEAD_OPEN_PATTERN.test(html)) {
		return html.replace(
			HEAD_OPEN_PATTERN,
			(match) => `${match}${CSP_META_TAG}`,
		);
	}
	if (HTML_OPEN_PATTERN.test(html)) {
		return html.replace(
			HTML_OPEN_PATTERN,
			(match) => `${match}<head>${CSP_META_TAG}</head>`,
		);
	}
	return `<head>${CSP_META_TAG}</head>${html}`;
}

/**
 * Sanitizes an AI-generated "self-contained HTML page" reply before it's
 * ever written to the vault. A prompt-injected clip can make the model emit
 * `<script>`, event handlers, `<iframe>`/`<object>`/`<embed>`/`<form>`,
 * external stylesheets, or `<meta http-equiv=refresh>` — opening the
 * resulting file in a browser/HTML viewer would execute or load them. This
 * strips all of that with DOMPurify and injects a restrictive CSP as
 * defense-in-depth for whatever slips through (e.g. remote `<img>` src).
 *
 * DOMPurify options verified against `node_modules/dompurify/dist/purify.cjs.d.ts`
 * (dompurify 3.4.11): `WHOLE_DOCUMENT`, `FORBID_TAGS`, `FORBID_ATTR`, and
 * `ALLOW_UNKNOWN_PROTOCOLS` all exist on `Config` as documented below.
 *
 * Requires a DOM (`window`) to operate — always present in the Obsidian
 * runtime (Electron/WebView). `win` is overridable for tests (a jsdom
 * window), and defaults to the global `window` otherwise.
 */
export function sanitizeHtmlDocument(
	html: string,
	win: PurifyWindow = typeof window === "undefined" ? undefined : window,
): string {
	if (!win) {
		throw new Error(
			"sanitizeHtmlDocument requires a DOM (window) environment.",
		);
	}

	const purifier = createDOMPurify(win);
	const clean = purifier.sanitize(html, {
		WHOLE_DOCUMENT: true,
		FORBID_TAGS: [
			"script",
			"iframe",
			"object",
			"embed",
			"form",
			"link",
			"base",
		],
		FORBID_ATTR: FORBIDDEN_EVENT_ATTRS,
		ALLOW_UNKNOWN_PROTOCOLS: false,
	});

	return `<!DOCTYPE html>\n${injectCsp(clean)}`;
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

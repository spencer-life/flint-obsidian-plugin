/**
 * Pure logic for the "Generate page and image from note" command: embedding
 * a generated image as a data URI into the top of a generated HTML page.
 * No `obsidian` imports here so this module stays unit-testable without the
 * Obsidian runtime.
 */

/** Builds a `data:` URI for an inline-embeddable image. */
export function buildDataUri(mimeType: string, base64: string): string {
	return `data:${mimeType};base64,${base64}`;
}

const BODY_OPEN_PATTERN = /<body[^>]*>/i;

/**
 * Embeds `dataUri` as an `<img>` at the top of `html`'s `<body>` (right
 * after the opening `<body ...>` tag). If no `<body>` tag is found, the
 * image is prepended to the document instead so the embed never silently
 * disappears.
 */
export function embedImageDataUri(html: string, dataUri: string): string {
	const imgTag = `<img src="${dataUri}" alt="Generated image" style="max-width:100%;height:auto;display:block;margin:0 0 1.5em;" />`;

	const match = html.match(BODY_OPEN_PATTERN);
	if (!match || match.index === undefined) {
		return `${imgTag}\n${html}`;
	}

	const insertAt = match.index + match[0].length;
	return `${html.slice(0, insertAt)}\n${imgTag}\n${html.slice(insertAt)}`;
}

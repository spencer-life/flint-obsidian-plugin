import { requestUrl } from "obsidian";
import TurndownService from "turndown";

/**
 * Below this length a direct HTML->Markdown conversion is treated as "thin"
 * (likely a paywall/JS-rendered shell) and, when a Firecrawl key is
 * configured, we fall back to Firecrawl's scrape API instead.
 */
export const THIN_CONTENT_THRESHOLD = 200;

/**
 * Firecrawl `/v2/scrape` request/response shape, verified 2026-07-04 against
 * https://docs.firecrawl.dev/api-reference/endpoint/scrape :
 *   POST https://api.firecrawl.dev/v2/scrape
 *   headers: Authorization: Bearer <key>, Content-Type: application/json
 *   body:    { url, formats: ["markdown"] }
 *   200 response: { success: true, data: { markdown: "...", ... } }
 */
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

export interface RefetchResult {
	markdown: string;
	via: "direct" | "firecrawl";
}

interface FirecrawlScrapeResponse {
	success?: boolean;
	data?: { markdown?: string };
}

/** Hard cap on a direct refetch's response body, to bound memory use against
 * an unexpectedly huge (or hostile) response. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MiB

// Literal hostnames/ranges that must never be reachable from the "refetch
// clip source" command: loopback, RFC 1918 private ranges, link-local, and
// the ".local" mDNS suffix. This is a literal-string check only — it can't
// protect against DNS rebinding (a hostname that resolves to a private IP at
// fetch time), because a portable, no-Node client has no way to inspect or
// pin the resolved IP before `requestUrl`/`fetch` connects. Blocking the
// obvious literal-host SSRF cases is what's feasible here.
const PRIVATE_HOSTNAME_PATTERNS: RegExp[] = [
	/^localhost$/i,
	/^127\./,
	/^0\.0\.0\.0$/,
	/^10\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.168\./,
	/^169\.254\./,
	/^::1$/,
	/^f[cd][0-9a-f]{2}:/i, // unique-local (fc00::/7)
	/^fe[89ab][0-9a-f]:/i, // link-local (fe80::/10)
	/^::ffff:/i, // IPv4-mapped
	/\.local$/i,
];

/**
 * Whether `url` is safe to fetch from the "refetch clip source" command:
 * http(s) only (rejects `file:`, `obsidian:`, `data:`, etc.) and not a
 * literal loopback/private/link-local/reserved host. See the SSRF caveat
 * above — this blocks literal-host SSRF only, not DNS rebinding.
 */
export function isSafePublicUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

	const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
	return !PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(hostname));
}

/** Converts fetched HTML to Markdown with Turndown. Exported for direct testing. */
export function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService();
	return turndown.turndown(html);
}

function contentTypeHeader(
	headers: Record<string, string> | undefined,
): string {
	if (!headers) return "";
	const key = Object.keys(headers).find(
		(k) => k.toLowerCase() === "content-type",
	);
	return key ? (headers[key] ?? "") : "";
}

const ALLOWED_CONTENT_TYPE =
	/^(text\/html|application\/xhtml\+xml|text\/plain)/i;

async function fetchDirect(url: string): Promise<string> {
	if (!isSafePublicUrl(url)) {
		throw new Error(`Refetch refused: "${url}" is not a safe public URL.`);
	}

	const response = await requestUrl({ url, method: "GET" });

	const contentType = contentTypeHeader(
		response.headers as Record<string, string> | undefined,
	);
	if (contentType && !ALLOWED_CONTENT_TYPE.test(contentType.trim())) {
		throw new Error(
			`Refetch refused: unexpected content-type "${contentType}".`,
		);
	}

	const byteLength = new TextEncoder().encode(response.text).length;
	if (byteLength > MAX_RESPONSE_BYTES) {
		throw new Error(
			`Refetch refused: response (${byteLength} bytes) exceeds the ${MAX_RESPONSE_BYTES}-byte cap.`,
		);
	}

	return htmlToMarkdown(response.text);
}

async function fetchFirecrawl(url: string, apiKey: string): Promise<string> {
	const response = await requestUrl({
		url: FIRECRAWL_SCRAPE_URL,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ url, formats: ["markdown"] }),
	});

	const parsed = response.json as FirecrawlScrapeResponse;
	const markdown = parsed?.data?.markdown;
	if (!markdown) {
		throw new Error("Firecrawl response did not include markdown content.");
	}
	return markdown;
}

/**
 * Fetches `url` and returns Markdown, preferring a direct `requestUrl` +
 * Turndown conversion. Falls back to Firecrawl (when `firecrawlApiKey` is
 * set) if the direct fetch throws or returns suspiciously thin content.
 */
export async function fetchAndConvert(
	url: string,
	firecrawlApiKey?: string,
): Promise<RefetchResult> {
	if (!isSafePublicUrl(url)) {
		throw new Error(`Refetch refused: "${url}" is not a safe public URL.`);
	}

	let direct: string | undefined;
	let directError: unknown;

	try {
		direct = await fetchDirect(url);
	} catch (error) {
		directError = error;
	}

	const isThin =
		direct === undefined || direct.trim().length < THIN_CONTENT_THRESHOLD;

	if (!isThin && direct !== undefined) {
		return { markdown: direct, via: "direct" };
	}

	if (firecrawlApiKey) {
		const markdown = await fetchFirecrawl(url, firecrawlApiKey);
		return { markdown, via: "firecrawl" };
	}

	if (direct !== undefined) {
		return { markdown: direct, via: "direct" };
	}

	throw directError instanceof Error
		? directError
		: new Error(`Failed to fetch ${url}`);
}

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

/** Converts fetched HTML to Markdown with Turndown. Exported for direct testing. */
export function htmlToMarkdown(html: string): string {
	const turndown = new TurndownService();
	return turndown.turndown(html);
}

async function fetchDirect(url: string): Promise<string> {
	const response = await requestUrl({ url, method: "GET" });
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

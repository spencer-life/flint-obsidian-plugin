import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const { fetchAndConvert, htmlToMarkdown, THIN_CONTENT_THRESHOLD } =
	await import("../src/ingest/refetch");

beforeEach(() => {
	resetObsidianMock();
});

describe("htmlToMarkdown", () => {
	test("converts a sample HTML document to Markdown via Turndown", () => {
		const html =
			"<article><h1>Title</h1><p>Hello <strong>world</strong>.</p><ul><li>One</li><li>Two</li></ul></article>";
		const markdown = htmlToMarkdown(html);

		expect(markdown).toContain("Title\n=====");
		expect(markdown).toContain("Hello **world**.");
		expect(markdown).toContain("*   One");
		expect(markdown).toContain("*   Two");
	});
});

describe("fetchAndConvert", () => {
	test("uses the direct requestUrl + Turndown path when content is substantial", async () => {
		const longParagraph = "Lorem ipsum dolor sit amet. ".repeat(20);
		setRequestUrlHandler(() => ({
			text: `<html><body><h1>Article</h1><p>${longParagraph}</p></body></html>`,
		}));

		const result = await fetchAndConvert("https://example.com/article");

		expect(result.via).toBe("direct");
		expect(result.markdown).toContain("Article\n=======");
		expect(requestUrlCalls).toHaveLength(1);
		expect(requestUrlCalls[0]?.url).toBe("https://example.com/article");
	});

	test("falls back to Firecrawl when direct content is thin and a key is configured", async () => {
		setRequestUrlHandler((params) => {
			if (params.url === "https://example.com/thin") {
				return { text: "<html><body><p>Too short.</p></body></html>" };
			}
			return {
				json: {
					success: true,
					data: { markdown: "# Full Article\n\nFull content from Firecrawl." },
				},
			};
		});

		const result = await fetchAndConvert(
			"https://example.com/thin",
			"fc-test-key",
		);

		expect(result.via).toBe("firecrawl");
		expect(result.markdown).toContain("Full content from Firecrawl.");
		expect(requestUrlCalls).toHaveLength(2);
	});

	test("Firecrawl request uses the verified /v2/scrape POST shape", async () => {
		setRequestUrlHandler((params) => {
			if (params.url === "https://api.firecrawl.dev/v2/scrape") {
				return { json: { success: true, data: { markdown: "# OK" } } };
			}
			return { text: "" }; // direct fetch: empty/thin, forces fallback
		});

		await fetchAndConvert("https://example.com/thin", "fc-secret");

		const firecrawlCall = requestUrlCalls.find(
			(call) => call.url === "https://api.firecrawl.dev/v2/scrape",
		);
		expect(firecrawlCall).toBeDefined();
		expect(firecrawlCall?.method).toBe("POST");
		expect(firecrawlCall?.headers?.["Authorization"]).toBe("Bearer fc-secret");
		expect(firecrawlCall?.headers?.["Content-Type"]).toBe("application/json");
		expect(JSON.parse(firecrawlCall?.body ?? "{}")).toEqual({
			url: "https://example.com/thin",
			formats: ["markdown"],
		});
	});

	test("returns direct thin content when no Firecrawl key is configured", async () => {
		setRequestUrlHandler(() => ({ text: "<p>Too short.</p>" }));

		const result = await fetchAndConvert("https://example.com/thin");

		expect(result.via).toBe("direct");
		expect(requestUrlCalls).toHaveLength(1);
	});

	test("THIN_CONTENT_THRESHOLD is a positive character count", () => {
		expect(THIN_CONTENT_THRESHOLD).toBeGreaterThan(0);
	});
});

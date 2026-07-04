import { beforeEach, describe, expect, test } from "bun:test";
import "./obsidian-mock";
import {
	requestUrlCalls,
	resetObsidianMock,
	setRequestUrlHandler,
} from "./obsidian-mock";

const {
	fetchAndConvert,
	htmlToMarkdown,
	isSafePublicUrl,
	MAX_RESPONSE_BYTES,
	THIN_CONTENT_THRESHOLD,
} = await import("../src/ingest/refetch");

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

	test("refuses to fetch a private/loopback/file URL, without a Firecrawl key", async () => {
		await expect(fetchAndConvert("http://localhost/secret")).rejects.toThrow();
		await expect(fetchAndConvert("http://127.0.0.1/secret")).rejects.toThrow();
		await expect(fetchAndConvert("file:///etc/passwd")).rejects.toThrow();
		expect(requestUrlCalls).toHaveLength(0);
	});

	test("rejects a response whose content-type isn't text/html-ish", async () => {
		setRequestUrlHandler(() => ({
			text: "binary-ish content",
			headers: { "Content-Type": "application/octet-stream" },
		}));

		await expect(
			fetchAndConvert("https://example.com/file.bin"),
		).rejects.toThrow(/content-type/);
	});

	test("rejects a response over the byte cap", async () => {
		setRequestUrlHandler(() => ({
			text: "x".repeat(MAX_RESPONSE_BYTES + 1),
		}));

		await expect(fetchAndConvert("https://example.com/huge")).rejects.toThrow(
			/exceeds/,
		);
	});
});

describe("isSafePublicUrl", () => {
	test("allows public https/http URLs", () => {
		expect(isSafePublicUrl("https://example.com/article")).toBe(true);
		expect(isSafePublicUrl("http://example.com/article")).toBe(true);
	});

	test("blocks localhost and loopback addresses", () => {
		expect(isSafePublicUrl("http://localhost/x")).toBe(false);
		expect(isSafePublicUrl("http://127.0.0.1/x")).toBe(false);
		expect(isSafePublicUrl("http://[::1]/x")).toBe(false);
	});

	test("blocks RFC 1918 private ranges and link-local", () => {
		expect(isSafePublicUrl("http://10.0.0.5/x")).toBe(false);
		expect(isSafePublicUrl("http://172.16.0.5/x")).toBe(false);
		expect(isSafePublicUrl("http://192.168.1.5/x")).toBe(false);
		expect(isSafePublicUrl("http://169.254.1.1/x")).toBe(false);
	});

	test("blocks .local mDNS hostnames", () => {
		expect(isSafePublicUrl("http://my-nas.local/x")).toBe(false);
	});

	test("blocks non-http(s) schemes", () => {
		expect(isSafePublicUrl("file:///etc/passwd")).toBe(false);
		expect(isSafePublicUrl("obsidian://open?vault=x")).toBe(false);
		expect(isSafePublicUrl("data:text/html,<script>1</script>")).toBe(false);
	});

	test("blocks a malformed URL", () => {
		expect(isSafePublicUrl("not a url")).toBe(false);
	});
});

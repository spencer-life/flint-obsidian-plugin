import { describe, expect, test } from "bun:test";
import { buildDataUri, embedImageDataUri } from "../src/generate/compose";

describe("buildDataUri", () => {
	test("builds a data: URI from a mime type and base64 payload", () => {
		expect(buildDataUri("image/png", "abc123")).toBe(
			"data:image/png;base64,abc123",
		);
	});
});

describe("embedImageDataUri", () => {
	test("inserts an <img> right after the opening <body> tag", () => {
		const html =
			"<!DOCTYPE html><html><head><title>T</title></head><body><h1>Hi</h1></body></html>";
		const dataUri = "data:image/png;base64,abc123";

		const result = embedImageDataUri(html, dataUri);

		const bodyIdx = result.indexOf("<body>");
		const imgIdx = result.indexOf("<img");
		const h1Idx = result.indexOf("<h1>");

		expect(imgIdx).toBeGreaterThan(bodyIdx);
		expect(imgIdx).toBeLessThan(h1Idx);
		expect(result).toContain(`src="${dataUri}"`);
	});

	test("handles a <body> tag with attributes", () => {
		const html = '<html><body class="dark"><p>Text</p></body></html>';
		const result = embedImageDataUri(html, "data:image/png;base64,xyz");

		expect(result.indexOf("<img")).toBeGreaterThan(
			result.indexOf('<body class="dark">'),
		);
		expect(result.indexOf("<img")).toBeLessThan(result.indexOf("<p>Text</p>"));
	});

	test("prepends the image when no <body> tag is present", () => {
		const html = "<h1>No body wrapper</h1>";
		const result = embedImageDataUri(html, "data:image/png;base64,xyz");

		expect(result.startsWith("<img")).toBe(true);
		expect(result).toContain("<h1>No body wrapper</h1>");
	});
});

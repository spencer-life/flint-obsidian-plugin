import { describe, expect, test } from "bun:test";
import {
	extractFirstHeading,
	extractSourceUrl,
	isClipProcessed,
	isWithinFolder,
	needsProcessing,
	sanitizeFilenameBase,
	splitFrontmatterBlock,
	stampClipFrontmatter,
	suggestFilename,
} from "../src/ingest/clip-processor";

describe("isClipProcessed / needsProcessing", () => {
	test("unmarked frontmatter is not processed", () => {
		expect(isClipProcessed(undefined)).toBe(false);
		expect(isClipProcessed({})).toBe(false);
		expect(isClipProcessed({ flint: "something-else" })).toBe(false);
	});

	test("flint: processed marks a clip as done", () => {
		expect(isClipProcessed({ flint: "processed" })).toBe(true);
	});

	test("needsProcessing requires the clippings folder and an unprocessed marker", () => {
		expect(
			needsProcessing("03 Clippings/a.md", "03 Clippings", undefined),
		).toBe(true);
		expect(
			needsProcessing("03 Clippings/a.md", "03 Clippings", {
				flint: "processed",
			}),
		).toBe(false);
		expect(needsProcessing("01 Projects/a.md", "03 Clippings", undefined)).toBe(
			false,
		);
		expect(
			needsProcessing("03 Clippings/a.pdf", "03 Clippings", undefined),
		).toBe(false);
	});

	test("isWithinFolder matches the folder and its children only", () => {
		expect(isWithinFolder("03 Clippings/a.md", "03 Clippings")).toBe(true);
		expect(isWithinFolder("03 Clippings", "03 Clippings")).toBe(true);
		expect(isWithinFolder("03 Clippings2/a.md", "03 Clippings")).toBe(false);
	});
});

describe("stampClipFrontmatter", () => {
	const now = new Date("2026-07-04T12:00:00.000Z");

	test("stamps a clip with no existing frontmatter fields", () => {
		const frontmatter: Record<string, unknown> = {};
		const changed = stampClipFrontmatter(frontmatter, {
			now,
			sourceUrl: "https://example.com/article",
		});

		expect(changed).toBe(true);
		expect(frontmatter.clipped).toBe(now.toISOString());
		expect(frontmatter.source).toBe("https://example.com/article");
		expect(frontmatter.flint).toBe("processed");
	});

	test("leaves an existing clipped/source value untouched", () => {
		const frontmatter: Record<string, unknown> = {
			clipped: "2020-01-01T00:00:00.000Z",
			source: "https://existing.example.com",
		};
		const changed = stampClipFrontmatter(frontmatter, {
			now,
			sourceUrl: "https://new.example.com",
		});

		expect(changed).toBe(true); // flint marker still gets added
		expect(frontmatter.clipped).toBe("2020-01-01T00:00:00.000Z");
		expect(frontmatter.source).toBe("https://existing.example.com");
		expect(frontmatter.flint).toBe("processed");
	});

	test("idempotency: a fully-stamped clip reports no change", () => {
		const frontmatter: Record<string, unknown> = {
			clipped: "2020-01-01T00:00:00.000Z",
			source: "https://existing.example.com",
			flint: "processed",
		};
		const changed = stampClipFrontmatter(frontmatter, { now });

		expect(changed).toBe(false);
		expect(frontmatter).toEqual({
			clipped: "2020-01-01T00:00:00.000Z",
			source: "https://existing.example.com",
			flint: "processed",
		});
	});
});

describe("extractSourceUrl", () => {
	test("finds a URL under known clipper keys", () => {
		expect(extractSourceUrl({ source: "https://a.example.com" })).toBe(
			"https://a.example.com",
		);
		expect(extractSourceUrl({ url: "https://b.example.com" })).toBe(
			"https://b.example.com",
		);
	});

	test("ignores non-URL values and missing frontmatter", () => {
		expect(extractSourceUrl({ source: "not a url" })).toBeUndefined();
		expect(extractSourceUrl(undefined)).toBeUndefined();
	});
});

describe("extractFirstHeading / splitFrontmatterBlock", () => {
	test("extracts the first H1 below frontmatter", () => {
		const content = "---\ntitle: x\n---\n\n# Real Title\n\nBody text.";
		expect(extractFirstHeading(content)).toBe("Real Title");
	});

	test("returns undefined when there is no H1", () => {
		expect(extractFirstHeading("Just some text.")).toBeUndefined();
	});

	test("splitFrontmatterBlock separates the frontmatter fence from the body", () => {
		const content = "---\ntitle: x\n---\nBody line one.\nBody line two.";
		const { frontmatterBlock, body } = splitFrontmatterBlock(content);
		expect(frontmatterBlock).toBe("---\ntitle: x\n---\n");
		expect(body).toBe("Body line one.\nBody line two.");
	});

	test("splitFrontmatterBlock handles content with no frontmatter", () => {
		const { frontmatterBlock, body } = splitFrontmatterBlock("Just body text.");
		expect(frontmatterBlock).toBe("");
		expect(body).toBe("Just body text.");
	});
});

describe("sanitizeFilenameBase / suggestFilename", () => {
	test("sanitizes unsafe characters and trims", () => {
		expect(sanitizeFilenameBase('Bad: Name? "Quoted" <tag>')).toBe(
			"Bad- Name- -Quoted- -tag-",
		);
	});

	test("suggests a rename for a generic placeholder basename", () => {
		const result = suggestFilename("Untitled", "How to Bake Sourdough Bread");
		expect(result).toBe("How to Bake Sourdough Bread");
	});

	test("does not suggest a rename for a normal filename", () => {
		expect(suggestFilename("How to Bake Sourdough Bread", "Anything")).toBe(
			null,
		);
	});

	test("does not suggest a rename when there's no title to use", () => {
		expect(suggestFilename("Untitled", undefined)).toBe(null);
	});
});

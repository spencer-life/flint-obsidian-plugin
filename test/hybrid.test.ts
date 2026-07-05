import { describe, expect, test } from "bun:test";
import type { VaultChunk } from "../src/index/chunk";
import { fuseRRF } from "../src/index/hybrid";

function chunk(id: string, overrides: Partial<VaultChunk> = {}): VaultChunk {
	return { id, path: `${id}.md`, heading: "", text: id, ...overrides };
}

describe("fuseRRF", () => {
	test("ranks a chunk appearing at the top of both lists above single-list chunks", () => {
		const keyword = [chunk("both"), chunk("keyword-only")];
		const vector = [chunk("both"), chunk("vector-only")];

		const fused = fuseRRF(keyword, vector, 10);

		expect(fused[0]?.id).toBe("both");
		expect(fused.map((c) => c.id)).toEqual(
			expect.arrayContaining(["both", "keyword-only", "vector-only"]),
		);
	});

	test("preserves relative order for a chunk that appears in only one list", () => {
		const keyword = [chunk("a"), chunk("b"), chunk("c")];
		const vector: VaultChunk[] = [];

		const fused = fuseRRF(keyword, vector, 10);

		expect(fused.map((c) => c.id)).toEqual(["a", "b", "c"]);
	});

	test("degrades gracefully when one side is empty", () => {
		const vector = [chunk("only-vector")];
		const fused = fuseRRF([], vector, 10);
		expect(fused.map((c) => c.id)).toEqual(["only-vector"]);
	});

	test("degrades gracefully when both sides are empty", () => {
		expect(fuseRRF([], [], 10)).toEqual([]);
	});

	test("respects the requested top-k limit", () => {
		const keyword = [chunk("a"), chunk("b"), chunk("c"), chunk("d")];
		const fused = fuseRRF(keyword, [], 2);
		expect(fused).toHaveLength(2);
		expect(fused.map((c) => c.id)).toEqual(["a", "b"]);
	});

	test("a chunk appearing near the top of both lists outranks one appearing only near the top of one", () => {
		// "both" is #2 in keyword and #2 in vector (score 2/61 ≈ 0.0328);
		// "keyword-only" is #1 in keyword alone (score 1/61 ≈ 0.0164).
		const keyword = [chunk("keyword-only"), chunk("both")];
		const vector = [chunk("other"), chunk("both")];

		const fused = fuseRRF(keyword, vector, 10);
		const bothIndex = fused.findIndex((c) => c.id === "both");
		const keywordOnlyIndex = fused.findIndex((c) => c.id === "keyword-only");

		expect(bothIndex).toBeLessThan(keywordOnlyIndex);
	});
});

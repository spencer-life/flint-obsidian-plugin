import { describe, expect, test } from "bun:test";
import {
	base64ToFloat32Array,
	deserializeStore,
	float32ArrayToBase64,
	type StoredChunkRecord,
	serializeStore,
	sha256Hex,
} from "../src/index/embedding-store";

describe("float32ArrayToBase64 / base64ToFloat32Array", () => {
	test("round-trips a small vector", () => {
		const vector = new Float32Array([0.1, -0.2, 0.3, 1, -1, 0]);
		const encoded = float32ArrayToBase64(vector);
		const decoded = base64ToFloat32Array(encoded);
		expect(Array.from(decoded)).toEqual(Array.from(vector));
	});

	test("round-trips an empty vector", () => {
		const vector = new Float32Array([]);
		const decoded = base64ToFloat32Array(float32ArrayToBase64(vector));
		expect(decoded.length).toBe(0);
	});

	test("round-trips a large vector without overflowing the call stack", () => {
		// Exercises the chunked binary-string conversion: large enough that a
		// naive `String.fromCharCode(...bytes)` spread would blow the stack.
		const length = 200_000;
		const vector = new Float32Array(length);
		for (let i = 0; i < length; i++) {
			vector[i] = Math.sin(i) * 100;
		}

		const encoded = float32ArrayToBase64(vector);
		const decoded = base64ToFloat32Array(encoded);

		expect(decoded.length).toBe(length);
		for (let i = 0; i < length; i += 997) {
			expect(decoded[i]).toBeCloseTo(vector[i] ?? 0, 4);
		}
	});
});

describe("sha256Hex", () => {
	test("is stable for the same input", async () => {
		const a = await sha256Hex("heading\ntext body");
		const b = await sha256Hex("heading\ntext body");
		expect(a).toBe(b);
		expect(a).toMatch(/^[0-9a-f]{64}$/);
	});

	test("differs for different input", async () => {
		const a = await sha256Hex("heading\ntext body");
		const b = await sha256Hex("heading\ndifferent text body");
		expect(a).not.toBe(b);
	});
});

describe("serializeStore / deserializeStore", () => {
	const header = {
		provider: "openai",
		model: "text-embedding-3-small",
		dims: 512,
	};

	function makeRecord(
		overrides: Partial<StoredChunkRecord> = {},
	): StoredChunkRecord {
		return {
			hash: "abc123",
			path: "notes/a.md",
			heading: "Intro",
			text: "Some text.",
			vector: new Float32Array([0.1, 0.2, 0.3]),
			...overrides,
		};
	}

	test("round-trips records through serialize/deserialize", () => {
		const records = [
			makeRecord(),
			makeRecord({ hash: "def456", path: "notes/b.md" }),
		];
		const json = serializeStore(header, records);
		const loaded = deserializeStore(json, header);

		expect(loaded).toHaveLength(2);
		expect(loaded[0]?.hash).toBe("abc123");
		expect(loaded[0]?.path).toBe("notes/a.md");
		expect(Array.from(loaded[0]?.vector ?? [])).toEqual(
			Array.from(new Float32Array([0.1, 0.2, 0.3])),
		);
	});

	test("invalidates the whole store on a provider mismatch", () => {
		const json = serializeStore(header, [makeRecord()]);
		const loaded = deserializeStore(json, { ...header, provider: "ollama" });
		expect(loaded).toEqual([]);
	});

	test("invalidates the whole store on a model mismatch", () => {
		const json = serializeStore(header, [makeRecord()]);
		const loaded = deserializeStore(json, { ...header, model: "other-model" });
		expect(loaded).toEqual([]);
	});

	test("invalidates the whole store on a dims mismatch", () => {
		const json = serializeStore(header, [makeRecord()]);
		const loaded = deserializeStore(json, { ...header, dims: 768 });
		expect(loaded).toEqual([]);
	});

	test("skips the dims check when the expected header has no dims (adaptive provider)", () => {
		const json = serializeStore({ ...header, dims: 768 }, [makeRecord()]);
		const loaded = deserializeStore(json, { ...header, dims: undefined });
		expect(loaded).toHaveLength(1);
	});

	test("discards corrupt JSON instead of throwing", () => {
		expect(deserializeStore("not json {{{", header)).toEqual([]);
	});

	test("discards a store with no records array", () => {
		expect(deserializeStore(JSON.stringify({ header }), header)).toEqual([]);
	});

	test("skips individually malformed records but keeps the rest", () => {
		const json = JSON.stringify({
			header,
			records: [
				{
					hash: "ok",
					path: "a.md",
					heading: "",
					text: "t",
					vector: float32ArrayToBase64(new Float32Array([1])),
				},
				{ hash: "bad", path: "b.md" }, // missing fields
				"not an object",
			],
		});
		const loaded = deserializeStore(json, header);
		expect(loaded).toHaveLength(1);
		expect(loaded[0]?.hash).toBe("ok");
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildImageRequest,
	buildVisualPromptRequest,
	decodeBase64ToBytes,
	extractImageBase64,
	imageMimeType,
	NIM_IMAGE_BASE_URL,
	nimBodyModelId,
	OPENAI_IMAGE_BASE_URL,
	sizeToAspectRatio,
} from "../src/generate/image";

describe("buildVisualPromptRequest", () => {
	test("includes the note title and content", () => {
		const messages = buildVisualPromptRequest("My Note", "Some content.");
		expect(messages[1]?.content).toContain("My Note");
		expect(messages[1]?.content).toContain("Some content.");
	});
});

describe("sizeToAspectRatio", () => {
	test("maps known sizes to NIM aspect ratios", () => {
		expect(sizeToAspectRatio("1024x1024")).toBe("1:1");
		expect(sizeToAspectRatio("1024x1792")).toBe("9:16");
		expect(sizeToAspectRatio("1792x1024")).toBe("16:9");
	});

	test("defaults unrecognized sizes to 1:1", () => {
		expect(sizeToAspectRatio("999x999")).toBe("1:1");
	});
});

describe("nimBodyModelId", () => {
	test("maps the verified SD3 path to its body model id", () => {
		expect(nimBodyModelId("stabilityai/stable-diffusion-3-medium")).toBe("sd3");
	});

	test("falls back to sd3 for unrecognized paths", () => {
		expect(nimBodyModelId("some/other-model")).toBe("sd3");
	});
});

describe("buildImageRequest", () => {
	test("builds the OpenAI-compatible shape: URL, headers, and body fields", () => {
		const built = buildImageRequest({
			provider: "openai",
			apiKey: "sk-test",
			model: "gpt-image-1",
			prompt: "A cat in a hat",
			size: "1024x1024",
		});

		expect(built.url).toBe(`${OPENAI_IMAGE_BASE_URL}/images/generations`);
		expect(built.headers.Authorization).toBe("Bearer sk-test");
		expect(built.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(built.body);
		expect(body).toEqual({
			model: "gpt-image-1",
			prompt: "A cat in a hat",
			n: 1,
			size: "1024x1024",
			response_format: "b64_json",
		});
	});

	test("builds the verified NIM shape: URL, headers, and body fields", () => {
		const built = buildImageRequest({
			provider: "nim",
			apiKey: "nvapi-test",
			model: "stabilityai/stable-diffusion-3-medium",
			prompt: "A cat in a hat",
			size: "1024x1792",
		});

		expect(built.url).toBe(
			`${NIM_IMAGE_BASE_URL}/genai/stabilityai/stable-diffusion-3-medium`,
		);
		expect(built.headers.Authorization).toBe("Bearer nvapi-test");
		expect(built.headers["Content-Type"]).toBe("application/json");

		const body = JSON.parse(built.body);
		expect(body.prompt).toBe("A cat in a hat");
		expect(body.mode).toBe("text-to-image");
		expect(body.model).toBe("sd3");
		expect(body.aspect_ratio).toBe("9:16");
		expect(body.output_format).toBe("jpeg");
		expect(typeof body.cfg_scale).toBe("number");
		expect(typeof body.steps).toBe("number");
		expect(body.seed).toBe(0);
	});
});

describe("extractImageBase64", () => {
	test("pulls b64_json out of the OpenAI response shape", () => {
		const json = { data: [{ b64_json: "abc123" }] };
		expect(extractImageBase64("openai", json)).toBe("abc123");
	});

	test("pulls image out of the NIM response shape", () => {
		const json = { image: "def456", finish_reason: "SUCCESS", seed: 0 };
		expect(extractImageBase64("nim", json)).toBe("def456");
	});

	test("throws a clear error when the expected field is missing", () => {
		expect(() => extractImageBase64("nim", {})).toThrow();
		expect(() => extractImageBase64("openai", { data: [{}] })).toThrow();
	});
});

describe("imageMimeType", () => {
	test("NIM's SD3 shape returns jpeg bytes", () => {
		expect(imageMimeType("nim")).toBe("image/jpeg");
	});

	test("OpenAI's b64_json defaults to png", () => {
		expect(imageMimeType("openai")).toBe("image/png");
	});
});

describe("decodeBase64ToBytes", () => {
	test("decodes a known base64 vector to the correct bytes", () => {
		// "Hello" -> base64 "SGVsbG8="
		const bytes = decodeBase64ToBytes("SGVsbG8=");
		expect(Array.from(bytes)).toEqual([72, 101, 108, 108, 111]);
	});

	test("round-trips arbitrary binary data (a tiny 1x1 PNG-like byte sequence)", () => {
		// Known vector: base64 of bytes [0x89, 0x50, 0x4e, 0x47] ("\x89PNG") is "iVBORw==".
		const bytes = decodeBase64ToBytes("iVBORw==");
		expect(Array.from(bytes)).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});
});

/**
 * Pure logic for the "Generate image from note" command: the visual-prompt
 * builder, the OpenAI-compatible and NIM image request shapes, and
 * base64 -> bytes decoding. No `obsidian` imports here so this module stays
 * unit-testable without the Obsidian runtime.
 */

import type { ChatMessage } from "../providers/types";

export type ImageProviderId = "nim" | "openai";

export const OPENAI_IMAGE_BASE_URL = "https://api.openai.com/v1";

/**
 * NVIDIA NIM image-generation base URL, verified 2026-07-04 against
 * https://docs.api.nvidia.com/nim/reference/stabilityai-stable-diffusion-3-medium-infer
 * (the embedded OpenAPI spec's `servers` entry).
 */
export const NIM_IMAGE_BASE_URL = "https://ai.api.nvidia.com/v1";

/** Builds the chat messages asking the active provider for a short, vivid
 * visual prompt derived from the note — fed to the image model as `prompt`. */
export function buildVisualPromptRequest(
	title: string,
	noteContent: string,
): ChatMessage[] {
	return [
		{
			role: "system",
			content:
				"You write short, vivid image-generation prompts. Given a note's title " +
				"and content, respond with ONLY a single descriptive visual prompt " +
				"(one or two sentences, no preamble, no quotes) that captures the note's " +
				"subject as an image.",
		},
		{
			role: "user",
			content: `Note title: ${title}\n\nNote content:\n\n${noteContent}`,
		},
	];
}

export interface ImageRequestOptions {
	provider: ImageProviderId;
	apiKey: string;
	/** For "openai": the image model name (e.g. "gpt-image-1"). For "nim":
	 * the model's API path segment (e.g. "stabilityai/stable-diffusion-3-medium"). */
	model: string;
	prompt: string;
	/** e.g. "1024x1024". Passed straight through for OpenAI; mapped to an
	 * `aspect_ratio` for NIM (see `sizeToAspectRatio`). */
	size: string;
}

export interface BuiltImageRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const ASPECT_RATIO_BY_SIZE: Record<string, string> = {
	"1024x1024": "1:1",
	"1024x1792": "9:16",
	"1792x1024": "16:9",
	"1024x1280": "4:5",
	"1280x1024": "5:4",
	"1024x1536": "2:3",
	"1536x1024": "3:2",
};

/** Maps a "WxH" size string to the closest NIM `aspect_ratio` enum value,
 * defaulting to "1:1" for anything unrecognized. */
export function sizeToAspectRatio(size: string): string {
	return ASPECT_RATIO_BY_SIZE[size] ?? "1:1";
}

/**
 * NIM's stable-diffusion-3-medium request body requires its own `model`
 * field distinct from the API path segment (e.g. path
 * `stabilityai/stable-diffusion-3-medium`, body `model: "sd3"`). This maps
 * known path segments to their body model id, falling back to "sd3" (the
 * only NIM image shape verified here) for anything else.
 */
export function nimBodyModelId(pathModel: string): string {
	const KNOWN: Record<string, string> = {
		"stabilityai/stable-diffusion-3-medium": "sd3",
	};
	return KNOWN[pathModel] ?? "sd3";
}

/**
 * Builds the `requestUrl` params for the configured image provider.
 *
 * OpenAI-compatible shape (verified against the public Images API):
 *   POST <baseUrl>/images/generations
 *   { model, prompt, n: 1, size, response_format: "b64_json" }
 *
 * NIM shape (VERIFIED DIFFERENT from OpenAI's — see
 * https://docs.api.nvidia.com/nim/reference/stabilityai-stable-diffusion-3-medium-infer):
 *   POST https://ai.api.nvidia.com/v1/genai/<model path>
 *   { prompt, mode: "text-to-image", model: <body model id>, cfg_scale,
 *     aspect_ratio, output_format: "jpeg", seed: 0, steps }
 *   -> response `{ image: <base64>, finish_reason, seed }` (no `data[]` wrapper).
 */
export function buildImageRequest(
	opts: ImageRequestOptions,
): BuiltImageRequest {
	if (opts.provider === "nim") {
		return {
			url: `${NIM_IMAGE_BASE_URL}/genai/${opts.model}`,
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				prompt: opts.prompt,
				mode: "text-to-image",
				model: nimBodyModelId(opts.model),
				cfg_scale: 5,
				aspect_ratio: sizeToAspectRatio(opts.size),
				output_format: "jpeg",
				seed: 0,
				steps: 50,
			}),
		};
	}

	return {
		url: `${OPENAI_IMAGE_BASE_URL}/images/generations`,
		headers: {
			Authorization: `Bearer ${opts.apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: opts.model,
			prompt: opts.prompt,
			n: 1,
			size: opts.size,
			response_format: "b64_json",
		}),
	};
}

/** Pulls the base64 image payload out of a provider's parsed JSON response,
 * accounting for the two different response shapes. */
export function extractImageBase64(
	provider: ImageProviderId,
	json: unknown,
): string {
	if (provider === "nim") {
		const parsed = json as { image?: string };
		if (typeof parsed?.image === "string" && parsed.image.length > 0) {
			return parsed.image;
		}
		throw new Error("NIM image response did not include an `image` field.");
	}

	const parsed = json as { data?: { b64_json?: string }[] };
	const b64 = parsed?.data?.[0]?.b64_json;
	if (typeof b64 === "string" && b64.length > 0) return b64;
	throw new Error("Image response did not include a `data[0].b64_json` field.");
}

/** MIME type of the raw bytes a provider actually returns (NIM's SD3 shape
 * requests `output_format: "jpeg"`; OpenAI's `b64_json` defaults to PNG). */
export function imageMimeType(provider: ImageProviderId): string {
	return provider === "nim" ? "image/jpeg" : "image/png";
}

/** File extension matching {@link imageMimeType}, so saved files never lie
 * about their contents. */
export function imageFileExtension(provider: ImageProviderId): string {
	return provider === "nim" ? "jpg" : "png";
}

/**
 * Decodes a base64 string to raw bytes using `atob` (no Node `Buffer` —
 * portable to mobile/browser runtimes).
 */
export function decodeBase64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

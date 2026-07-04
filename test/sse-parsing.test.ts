import { describe, expect, test } from "bun:test";
import { SSEParser } from "../src/providers/sse";

/** Splits a string into fragments of the given size, simulating arbitrary
 * chunk boundaries from a network stream (which do not align with SSE event
 * or even line boundaries). */
function fragment(input: string, size: number): string[] {
	const parts: string[] = [];
	for (let i = 0; i < input.length; i += size) {
		parts.push(input.slice(i, i + size));
	}
	return parts;
}

describe("SSEParser — fragmented chunk assembly", () => {
	test("Anthropic-shaped content_block_delta events split across arbitrary byte boundaries", () => {
		const events = [
			{
				type: "content_block_delta",
				delta: { type: "text_delta", text: "Hello" },
			},
			{
				type: "content_block_delta",
				delta: { type: "text_delta", text: ", world" },
			},
			{
				type: "content_block_delta",
				delta: { type: "text_delta", text: "!" },
			},
		];
		const raw = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

		const received: string[] = [];
		const parser = new SSEParser((data) => {
			const parsed = JSON.parse(data) as {
				delta?: { text?: string };
			};
			if (parsed.delta?.text) received.push(parsed.delta.text);
		});

		// Fragment at a size small enough to routinely split mid-event, mid-line,
		// and mid-JSON-token, including right on the "\n\n" boundary itself.
		for (const piece of fragment(raw, 7)) {
			parser.push(piece);
		}
		parser.flush();

		expect(received.join("")).toBe("Hello, world!");
	});

	test("OpenAI-shaped choices[0].delta.content events split across arbitrary byte boundaries", () => {
		const events = [
			{ choices: [{ delta: { content: "The " } }] },
			{ choices: [{ delta: { content: "quick " } }] },
			{ choices: [{ delta: { content: "fox" } }] },
		];
		const raw =
			events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") +
			"data: [DONE]\n\n";

		const received: string[] = [];
		const parser = new SSEParser((data) => {
			if (data === "[DONE]") return;
			const parsed = JSON.parse(data) as {
				choices?: { delta?: { content?: string } }[];
			};
			const token = parsed.choices?.[0]?.delta?.content;
			if (token) received.push(token);
		});

		for (const piece of fragment(raw, 3)) {
			parser.push(piece);
		}
		parser.flush();

		expect(received.join("")).toBe("The quick fox");
	});

	test("a single event split exactly at the data: prefix boundary is still assembled", () => {
		const payload = JSON.stringify({
			choices: [{ delta: { content: "split-me" } }],
		});
		const raw = `data: ${payload}\n\n`;

		const received: string[] = [];
		const parser = new SSEParser((data) => received.push(data));

		// Split right after "data:" (before the space+payload) and again in the
		// middle of the payload itself.
		parser.push(raw.slice(0, 5));
		parser.push(raw.slice(5, 20));
		parser.push(raw.slice(20));
		parser.flush();

		expect(received).toHaveLength(1);
		expect(JSON.parse(received[0] ?? "{}").choices[0].delta.content).toBe(
			"split-me",
		);
	});

	test("a trailing event with no closing blank line is emitted on flush()", () => {
		const received: string[] = [];
		const parser = new SSEParser((data) => received.push(data));

		parser.push('data: {"choices":[{"delta":{"content":"tail"}}]}');
		// No trailing "\n\n" — simulates the stream ending mid-event.
		parser.flush();

		expect(received).toHaveLength(1);
	});
});

/**
 * Incremental SSE ("text/event-stream") parser. Feed it arbitrary chunks of
 * raw text as they arrive over the wire — chunk boundaries do not need to
 * align with event or line boundaries — and it emits each event's `data:`
 * payload once a complete event (terminated by a blank line) has arrived.
 */
export class SSEParser {
	private buffer = "";

	constructor(private onEvent: (data: string) => void) {}

	push(chunk: string): void {
		this.buffer += chunk.replace(/\r\n/g, "\n");
		let boundary: number;
		while ((boundary = this.buffer.indexOf("\n\n")) !== -1) {
			const rawEvent = this.buffer.slice(0, boundary);
			this.buffer = this.buffer.slice(boundary + 2);
			this.emit(rawEvent);
		}
	}

	/** Flush any trailing buffered event that never received a closing blank line. */
	flush(): void {
		if (this.buffer.trim().length > 0) {
			this.emit(this.buffer);
		}
		this.buffer = "";
	}

	private emit(rawEvent: string): void {
		for (const line of rawEvent.split("\n")) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data.length > 0) this.onEvent(data);
		}
	}
}

/**
 * Reads a fetch `Response` body as an SSE stream, calling `onEvent` for each
 * event's `data:` payload. Stops early if `signal` is aborted.
 */
export async function consumeSSEStream(
	response: Response,
	onEvent: (data: string) => void,
	signal?: AbortSignal,
): Promise<void> {
	const body = response.body;
	if (!body) return;

	const reader = body.getReader();
	const decoder = new TextDecoder();
	const parser = new SSEParser(onEvent);

	try {
		while (true) {
			if (signal?.aborted) {
				await reader.cancel();
				return;
			}
			const { done, value } = await reader.read();
			if (done) break;
			parser.push(decoder.decode(value, { stream: true }));
		}
		parser.flush();
	} finally {
		reader.releaseLock();
	}
}

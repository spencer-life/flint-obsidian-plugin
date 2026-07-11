export class RequestTimeoutError extends Error {
	constructor(label: string, ms: number) {
		super(
			`${label} timed out after ${Math.round(ms / 1000)}s — no response. Check your connection or model, then try again.`,
		);
		this.name = "RequestTimeoutError";
	}
}

export interface DeadlineOptions {
	signal?: AbortSignal;
	ms: number;
	label: string;
}

/**
 * Reject a request promise on timeout or user abort. Obsidian's `requestUrl`
 * has no timeout and can't be cancelled; even `fetch` can stall after headers.
 * This makes a stall a prompt, named rejection so the UI unsticks (a late
 * underlying response is ignored). It does NOT physically cancel requestUrl.
 */
export function withDeadline<T>(
	request: Promise<T>,
	opts: DeadlineOptions,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;

		const settle = (action: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			opts.signal?.removeEventListener("abort", onAbort);
			action();
		};

		const timer = setTimeout(
			() => settle(() => reject(new RequestTimeoutError(opts.label, opts.ms))),
			opts.ms,
		);

		const onAbort = () => {
			settle(() => reject(new DOMException("Aborted", "AbortError")));
		};

		if (opts.signal?.aborted) {
			settle(() => reject(new DOMException("Aborted", "AbortError")));
			return;
		}
		opts.signal?.addEventListener("abort", onAbort, { once: true });

		request.then(
			(value) => settle(() => resolve(value)),
			(err: unknown) => settle(() => reject(err)),
		);
	});
}

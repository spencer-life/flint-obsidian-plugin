export type ToolCardStatus =
	| "running"
	| "awaiting"
	| "applied"
	| "skipped"
	| "done"
	| "error"
	| "capped";

export interface ToolCardState {
	callId: string;
	name: string;
	/** One-line human summary, e.g. `Move "x.md" → 01 Projects`. */
	summary: string;
	/** Pretty-printed arguments for the expanded proposal body. Rendered as
	 * PLAIN TEXT only — proposal content is model output derived from vault
	 * content and must never hit MarkdownRenderer. */
	detail?: string;
	mutating: boolean;
	status: ToolCardStatus;
	resultPreview?: string;
}

const STATUS_LABEL: Record<ToolCardStatus, string> = {
	running: "Running…",
	awaiting: "Awaiting approval",
	applied: "Applied",
	skipped: "Skipped",
	done: "Done",
	error: "Error",
	capped: "Not executed",
};

/**
 * One tool invocation in the chat transcript. Read-only calls render as a
 * compact chip; mutating calls render as a card with the proposal body and,
 * while awaiting, Apply/Skip buttons wired back to the agent loop's
 * suspended confirmation promise.
 */
export function ToolCard({
	tool,
	onDecide,
}: {
	tool: ToolCardState;
	onDecide: (callId: string, decision: "apply" | "skip") => void;
}) {
	if (!tool.mutating) {
		return (
			<div className={`flint-tool-chip flint-tool-${tool.status}`}>
				<span className="flint-tool-chip-name">{tool.summary}</span>
				<span className="flint-tool-chip-status">
					{tool.status === "running" ? "…" : ""}
					{tool.status === "error" ? "!" : ""}
				</span>
			</div>
		);
	}

	return (
		<div className={`flint-tool-card flint-tool-${tool.status}`}>
			<div className="flint-tool-card-header">
				<span className="flint-tool-card-summary">{tool.summary}</span>
				<span className="flint-tool-card-status">
					{STATUS_LABEL[tool.status]}
				</span>
			</div>
			{tool.detail && (
				<pre className="flint-tool-card-detail">{tool.detail}</pre>
			)}
			{tool.status === "awaiting" && (
				<div className="flint-tool-card-actions">
					<button
						type="button"
						className="flint-tool-apply"
						onClick={() => onDecide(tool.callId, "apply")}
					>
						Apply
					</button>
					<button
						type="button"
						className="flint-tool-skip"
						onClick={() => onDecide(tool.callId, "skip")}
					>
						Skip
					</button>
				</div>
			)}
			{tool.resultPreview && tool.status !== "awaiting" && (
				<div className="flint-tool-card-result">{tool.resultPreview}</div>
			)}
		</div>
	);
}

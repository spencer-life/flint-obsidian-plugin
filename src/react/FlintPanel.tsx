import { Component, MarkdownRenderer } from "obsidian";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { neutralizeRemoteImageMarkdown, runPipeline } from "../chat/pipeline";
import { fetchModels, getProvider } from "../providers";
import type { ChatMessage } from "../providers/types";
import type { ProviderId } from "../settings";
import { useApp, usePlugin } from "./context";

// Protocol-relative (`//host/...`) or absolute http(s) URL.
const REMOTE_URL_PATTERN = /^(?:https?:)?\/\//i;

/** True when any URL in a (possibly comma-separated `srcset`) attribute
 * value points at a remote host. */
function hasRemoteUrl(value: string | null): boolean {
	if (!value) return false;
	return value
		.split(",")
		.map((part) => part.trim().split(/\s+/)[0] ?? "")
		.some((url) => REMOTE_URL_PATTERN.test(url));
}

/**
 * Post-render DOM scrub, as defense-in-depth alongside
 * `neutralizeRemoteImageMarkdown`: removes any `img`/`iframe`/`audio`/
 * `video`/`embed`/`object`/`source` left with a remote `src`/`srcset` (e.g.
 * from raw HTML the model embedded in its reply, which Markdown transforms
 * alone can't catch) and any `link[rel=stylesheet]`, both of which Obsidian's
 * `MarkdownRenderer` would otherwise silently fetch.
 */
function scrubRemoteEmbeds(root: HTMLElement): void {
	const embeds = root.querySelectorAll(
		"img,iframe,audio,video,embed,object,source",
	);
	for (const el of Array.from(embeds)) {
		if (
			hasRemoteUrl(el.getAttribute("src")) ||
			hasRemoteUrl(el.getAttribute("srcset"))
		) {
			el.remove();
		}
	}
	for (const el of Array.from(
		root.querySelectorAll('link[rel="stylesheet"]'),
	)) {
		el.remove();
	}
}

interface FlintMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	citations?: string[];
	isError?: boolean;
}

let messageCounter = 0;
function nextId(): string {
	messageCounter += 1;
	return `flint-msg-${messageCounter}`;
}

function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/\b404\b/.test(message)) {
		return `Model not found (404) — check the model id. Some provider models are deprecated or renamed. (${message})`;
	}
	return message;
}

function AssistantMarkdown({ content }: { content: string }) {
	const app = useApp();
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el) return undefined;

		const component = new Component();
		component.load();
		el.empty();
		const sourcePath = app.workspace.getActiveFile()?.path ?? "";
		let cancelled = false;
		void MarkdownRenderer.render(
			app,
			neutralizeRemoteImageMarkdown(content),
			el,
			sourcePath,
			component,
		).then(() => {
			if (!cancelled) scrubRemoteEmbeds(el);
		});

		return () => {
			cancelled = true;
			component.unload();
		};
	}, [app, content]);

	return <div className="flint-markdown" ref={ref} />;
}

function Citations({ paths }: { paths: string[] }) {
	const app = useApp();
	if (paths.length === 0) return null;

	return (
		<div className="flint-citations">
			{paths.map((path) => (
				<a
					key={path}
					className="flint-citation"
					href="#"
					onClick={(event) => {
						event.preventDefault();
						void app.workspace.openLinkText(path, "", false);
					}}
				>
					{path}
				</a>
			))}
		</div>
	);
}

export function FlintPanel() {
	const plugin = usePlugin();

	const [provider, setProvider] = useState<ProviderId>(
		plugin.settings.activeProvider,
	);
	const [model, setModel] = useState(plugin.settings.activeModel);
	const [modelOptions, setModelOptions] = useState<string[]>([]);
	const [modelStatus, setModelStatus] = useState<"loading" | "ready" | "error">(
		"loading",
	);
	const [modelError, setModelError] = useState("");
	const modelListId = useId();
	const [messages, setMessages] = useState<FlintMessage[]>([]);
	const [input, setInput] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [testStatus, setTestStatus] = useState<
		"idle" | "testing" | "ok" | "error"
	>("idle");
	const [testMessage, setTestMessage] = useState("");

	const abortRef = useRef<AbortController | null>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	const updateProvider = useCallback(
		(value: ProviderId) => {
			setProvider(value);
			plugin.settings.activeProvider = value;
			void plugin.saveSettings();
		},
		[plugin],
	);

	const updateModel = useCallback(
		(value: string) => {
			setModel(value);
			plugin.settings.activeModel = value;
			void plugin.saveSettings();
		},
		[plugin],
	);

	const loadModels = useCallback(
		async (force: boolean) => {
			setModelStatus("loading");
			setModelError("");
			try {
				const models = await fetchModels(provider, plugin.settings, {
					force,
				});
				setModelOptions(models);
				setModelStatus("ready");
			} catch (err) {
				setModelStatus("error");
				setModelError(err instanceof Error ? err.message : String(err));
			}
		},
		[provider, plugin],
	);

	useEffect(() => {
		let cancelled = false;
		setModelStatus("loading");
		setModelError("");

		fetchModels(provider, plugin.settings)
			.then((models) => {
				if (cancelled) return;
				setModelOptions(models);
				setModelStatus("ready");
			})
			.catch((err) => {
				if (cancelled) return;
				setModelStatus("error");
				setModelError(err instanceof Error ? err.message : String(err));
			});

		return () => {
			cancelled = true;
		};
	}, [provider, plugin]);

	const handleTestConnection = useCallback(async () => {
		setTestStatus("testing");
		setTestMessage("");
		try {
			const testProvider = getProvider(plugin.settings);
			await testProvider.chat(
				[{ role: "user", content: "Reply with just: OK" }],
				{
					model: plugin.settings.activeModel,
					maxTokens: 8,
				},
			);
			setTestStatus("ok");
			setTestMessage("Connection OK.");
		} catch (err) {
			setTestStatus("error");
			setTestMessage(describeError(err));
		}
	}, [plugin]);

	const handleStop = useCallback(() => {
		abortRef.current?.abort();
	}, []);

	const handleSend = useCallback(async () => {
		const query = input.trim();
		if (!query || isSending) return;

		setInput("");
		setError(null);

		const history: ChatMessage[] = messages
			.filter((m) => !m.isError)
			.map((m) => ({ role: m.role, content: m.content }));

		const userMessage: FlintMessage = {
			id: nextId(),
			role: "user",
			content: query,
		};
		const assistantId = nextId();
		const assistantMessage: FlintMessage = {
			id: assistantId,
			role: "assistant",
			content: "",
		};

		setMessages((prev) => [...prev, userMessage, assistantMessage]);
		setIsSending(true);

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			const result = await runPipeline(
				query,
				plugin.settings,
				plugin.vaultIndex,
				{
					history,
					stream: plugin.settings.streamResponses,
					signal: controller.signal,
					onToken: (token) => {
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantId ? { ...m, content: m.content + token } : m,
							),
						);
					},
				},
			);

			setMessages((prev) =>
				prev.map((m) =>
					m.id === assistantId
						? { ...m, content: result.answer, citations: result.citations }
						: m,
				),
			);
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantId && m.content.length === 0
							? { ...m, content: "(stopped)" }
							: m,
					),
				);
			} else {
				const message = describeError(err);
				setError(message);
				setMessages((prev) =>
					prev.map((m) =>
						m.id === assistantId
							? { ...m, content: message, isError: true }
							: m,
					),
				);
			}
		} finally {
			setIsSending(false);
			abortRef.current = null;
		}
	}, [input, isSending, messages, plugin]);

	return (
		<div className="flint-panel">
			<div className="flint-header">
				<span className="flint-title">Flint</span>
				<div className="flint-controls">
					<select
						className="flint-provider-select"
						value={provider}
						onChange={(event) =>
							updateProvider(event.target.value as ProviderId)
						}
					>
						<option value="anthropic">Anthropic</option>
						<option value="nim">NVIDIA NIM</option>
						<option value="openai">OpenAI</option>
						<option value="ollama">Ollama</option>
					</select>
					<input
						className="flint-model-input"
						type="text"
						list={modelListId}
						placeholder="model id"
						value={model}
						onChange={(event) => updateModel(event.target.value)}
					/>
					<datalist id={modelListId}>
						{(model && !modelOptions.includes(model)
							? [model, ...modelOptions]
							: modelOptions
						).map((id) => (
							<option key={id} value={id} />
						))}
					</datalist>
					<button
						type="button"
						className="flint-refresh-btn"
						onClick={() => void loadModels(true)}
						disabled={modelStatus === "loading"}
						title={modelStatus === "error" ? modelError : "Refresh model list"}
					>
						↻
					</button>
					<button
						type="button"
						className="flint-test-btn"
						onClick={() => void handleTestConnection()}
						disabled={testStatus === "testing"}
					>
						{testStatus === "testing" ? "Testing…" : "Test"}
					</button>
				</div>
			</div>

			{modelStatus === "error" && (
				<div className="flint-test-status flint-test-error">
					{modelError || "Couldn't load model list — using free text."}
				</div>
			)}

			{testStatus !== "idle" && (
				<div className={`flint-test-status flint-test-${testStatus}`}>
					{testMessage}
				</div>
			)}

			<div className="flint-messages" ref={listRef}>
				{messages.length === 0 && (
					<div className="flint-empty">
						Ask your vault something to get started.
					</div>
				)}
				{messages.map((m) => (
					<div
						key={m.id}
						className={`flint-message flint-message-${m.role}${m.isError ? " flint-message-error" : ""}`}
					>
						{m.role === "assistant" ? (
							<AssistantMarkdown content={m.content || "…"} />
						) : (
							<div className="flint-user-text">{m.content}</div>
						)}
						{m.citations && m.citations.length > 0 && (
							<Citations paths={m.citations} />
						)}
					</div>
				))}
			</div>

			{error && <div className="flint-error">{error}</div>}

			<div className="flint-input-row">
				<textarea
					className="flint-input"
					placeholder="Ask your vault..."
					value={input}
					onChange={(event) => setInput(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							void handleSend();
						}
					}}
					disabled={isSending}
				/>
				{isSending ? (
					<button type="button" className="flint-stop" onClick={handleStop}>
						Stop
					</button>
				) : (
					<button
						type="button"
						className="flint-send"
						onClick={() => void handleSend()}
						disabled={!input.trim()}
					>
						Send
					</button>
				)}
			</div>
		</div>
	);
}

import {
	arrayBufferToBase64,
	Component,
	MarkdownRenderer,
	Notice,
	normalizePath,
	TFile,
} from "obsidian";
import { useCallback, useEffect, useRef, useState } from "react";
import { runAgentLoop } from "../agent/loop";
import { buildAgentSystemPrompt } from "../agent/system-prompt";
import { TOOL_DEFINITIONS } from "../agent/tool-schemas";
import { VaultToolExecutor } from "../agent/vault-tools";
import { renderFolderTree } from "../agent/vault-tree";
import { neutralizeRemoteImageMarkdown, runPipeline } from "../chat/pipeline";
import {
	fetchModels,
	getProvider,
	getProviderFor,
	resolveSampling,
} from "../providers";
import type {
	AgentMessage,
	ChatMessage,
	ContentPart,
} from "../providers/types";
import { ToolsUnsupportedError } from "../providers/types";
import { type ProviderId, resolveTaskModel } from "../settings";
import { ModelSuggest } from "../ui/model-suggest";
import { NotePickerModal } from "../ui/note-picker";
import { useApp, usePlugin } from "./context";
import { Suggestions } from "./Suggestions";
import { ToolCard, type ToolCardState } from "./ToolCard";

// Soft cap on how many notes can be attached as references at once, so the
// pinned-notes section in the system prompt (each capped at ~4000 chars in
// the pipeline) can't grow unbounded.
const MAX_ATTACHMENTS = 5;

// Pasted/attached image caps: count per message and bytes per image.
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

// Folder-tree caps for the agent system prompt (computed per send).
const AGENT_TREE_DEPTH = 4;
const AGENT_TREE_ENTRIES = 150;

// Filing-guide excerpt cap in the agent system prompt.
const AGENT_GUIDE_CHARS = 2000;

// Cap on the pretty-printed proposal body inside a tool card.
const TOOL_DETAIL_CHARS = 1500;

// Cap on the result preview line under a finished tool card.
const TOOL_PREVIEW_CHARS = 200;

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

/** True for a `data:` URL — used to strip inline data-URI frames/objects that
 * could carry an HTML/script payload. */
function isDataUrl(value: string | null): boolean {
	return !!value && /^data:/i.test(value.trim());
}

/**
 * Post-render DOM scrub, as defense-in-depth alongside
 * `neutralizeRemoteImageMarkdown`: removes any `img`/`iframe`/`audio`/
 * `video`/`embed`/`object`/`source` left with a remote `src`/`srcset` (e.g.
 * from raw HTML the model embedded in its reply, which Markdown transforms
 * alone can't catch), any `iframe[srcdoc]` (inline HTML the model could use
 * to run script in the panel), any `data:` URL on a frame/object `src`, and
 * any `style`/`link[rel=stylesheet]`, all of which Obsidian's
 * `MarkdownRenderer` would otherwise silently render or fetch.
 */
function scrubRemoteEmbeds(root: HTMLElement): void {
	const embeds = root.querySelectorAll(
		"img,iframe,audio,video,embed,object,source",
	);
	for (const el of Array.from(embeds)) {
		if (
			hasRemoteUrl(el.getAttribute("src")) ||
			hasRemoteUrl(el.getAttribute("srcset")) ||
			el.hasAttribute("srcdoc") ||
			isDataUrl(el.getAttribute("src"))
		) {
			el.remove();
		}
	}
	for (const el of Array.from(
		root.querySelectorAll('style,link[rel="stylesheet"]'),
	)) {
		el.remove();
	}
}

/** One rendered part of an assistant message in agent mode: streamed text
 * or a tool invocation card. */
type MessagePart =
	| { type: "text"; text: string }
	| { type: "tool"; tool: ToolCardState };

/** An image attached to the outgoing message (pasted or picked). */
interface ImageAttachment {
	name: string;
	mimeType: string;
	base64: string;
}

interface FlintMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** Agent-mode assistant messages render from parts (text + tool cards);
	 * `content` still carries the final text for history/fallback. */
	parts?: MessagePart[];
	/** Thumbnails for images the user sent with this message. */
	images?: ImageAttachment[];
	citations?: string[];
	isError?: boolean;
}

let messageCounter = 0;
function nextId(): string {
	messageCounter += 1;
	return `flint-msg-${messageCounter}`;
}

/** Maps pasted/attached images to provider-neutral content parts — shared by
 * agent mode and the RAG pipeline so both send images the same way. */
function toContentParts(images: ImageAttachment[]): ContentPart[] {
	return images.map(
		(image): ContentPart => ({
			type: "image",
			mimeType: image.mimeType,
			base64: image.base64,
		}),
	);
}

function describeError(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	if (/image|vision|multimodal|multi-modal/i.test(message)) {
		return `This model can't read images — try a vision-capable model. (${message})`;
	}
	if (/\b404\b/.test(message)) {
		return `Model not found (404) — check the model id. Some provider models are deprecated or renamed. (${message})`;
	}
	return message;
}

/** Pretty proposal body for a tool card from the raw argument JSON — plain
 * text only, capped. Falls back to the raw string when unparseable. */
function toolDetail(rawArguments: string): string | undefined {
	if (rawArguments.trim().length === 0) return undefined;
	let text: string;
	try {
		text = JSON.stringify(JSON.parse(rawArguments), null, 2);
	} catch {
		text = rawArguments;
	}
	return text.length > TOOL_DETAIL_CHARS
		? `${text.slice(0, TOOL_DETAIL_CHARS)}\n[truncated]`
		: text;
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
				// biome-ignore lint/a11y/useValidAnchor: styled as an Obsidian internal link; a button would lose the native link affordance
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
	const app = useApp();
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
	const [messages, setMessages] = useState<FlintMessage[]>([]);
	const [input, setInput] = useState("");
	const [isSending, setIsSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [testStatus, setTestStatus] = useState<
		"idle" | "testing" | "ok" | "error"
	>("idle");
	const [testMessage, setTestMessage] = useState("");
	const [attachments, setAttachments] = useState<TFile[]>([]);
	const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>(
		[],
	);
	const [agentMode, setAgentMode] = useState(plugin.settings.agentMode);

	const abortRef = useRef<AbortController | null>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const modelInputRef = useRef<HTMLInputElement>(null);
	const modelOptionsRef = useRef<string[]>(modelOptions);
	const modelSuggestRef = useRef<ModelSuggest | null>(null);
	// Full provider-facing agent transcript across turns (system prompt is
	// prepended fresh on every send, so it's never stored here).
	const agentTranscriptRef = useRef<AgentMessage[]>([]);
	// Resolvers for tool confirmations currently awaiting an Apply/Skip click.
	const confirmResolversRef = useRef(
		new Map<string, (decision: "apply" | "skip") => void>(),
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `messages` is the intentional trigger — scroll to bottom whenever a message is added, even though the effect body only touches the ref
	useEffect(() => {
		const el = listRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages]);

	// Leak guard: closing the view aborts any in-flight agent run, which also
	// unblocks a suspended confirmation (the loop races confirm vs. abort).
	useEffect(() => {
		return () => {
			abortRef.current?.abort();
			confirmResolversRef.current.clear();
		};
	}, []);

	useEffect(() => {
		modelOptionsRef.current = modelOptions;
	}, [modelOptions]);

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
		const inputEl = modelInputRef.current;
		// Guard against double-attach across StrictMode's dev-only double
		// effect invocation — AbstractInputSuggest has no destroy(), so once
		// attached to an input element we leave it alone for the panel's
		// lifetime rather than tearing down and recreating listeners.
		if (!inputEl || modelSuggestRef.current) return;
		modelSuggestRef.current = new ModelSuggest(
			app,
			inputEl,
			() => modelOptionsRef.current,
			(value) => updateModel(value),
		);
	}, [app, updateModel]);

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

	const handleAttach = useCallback(() => {
		if (attachments.length >= MAX_ATTACHMENTS) return;
		const modal = new NotePickerModal(
			app,
			attachments.map((file) => file.path),
			(file) => {
				setAttachments((prev) =>
					prev.some((f) => f.path === file.path) ? prev : [...prev, file],
				);
			},
		);
		modal.open();
	}, [app, attachments]);

	const handleRemoveAttachment = useCallback((path: string) => {
		setAttachments((prev) => prev.filter((f) => f.path !== path));
	}, []);

	const updateAgentMode = useCallback(
		(value: boolean) => {
			setAgentMode(value);
			plugin.settings.agentMode = value;
			void plugin.saveSettings();
		},
		[plugin],
	);

	const addImageFiles = useCallback(async (files: File[]) => {
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			if (file.size > MAX_IMAGE_BYTES) {
				new Notice("Flint: image too large (4 MB max).");
				continue;
			}
			const buffer = await file.arrayBuffer();
			const base64 = arrayBufferToBase64(buffer);
			setImageAttachments((prev) =>
				prev.length >= MAX_IMAGES
					? prev
					: [
							...prev,
							{
								name: file.name || "pasted image",
								mimeType: file.type,
								base64,
							},
						],
			);
		}
	}, []);

	const handlePaste = useCallback(
		(event: React.ClipboardEvent<HTMLTextAreaElement>) => {
			if (!agentMode) return;
			const files = Array.from(event.clipboardData?.files ?? []).filter(
				(file) => file.type.startsWith("image/"),
			);
			if (files.length === 0) return;
			event.preventDefault();
			void addImageFiles(files);
		},
		[agentMode, addImageFiles],
	);

	const handleRemoveImage = useCallback((index: number) => {
		setImageAttachments((prev) => prev.filter((_, i) => i !== index));
	}, []);

	/** Apply/Skip click → resolve the loop's suspended confirmation. */
	const handleToolDecision = useCallback(
		(callId: string, decision: "apply" | "skip") => {
			const resolve = confirmResolversRef.current.get(callId);
			if (!resolve) return;
			confirmResolversRef.current.delete(callId);
			resolve(decision);
		},
		[],
	);

	/** Streams/patches the assistant message with `id` through `patch`. */
	const patchAssistant = useCallback(
		(id: string, patch: (message: FlintMessage) => FlintMessage) => {
			setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
		},
		[],
	);

	/** Patches one tool card (by call id) inside the assistant message. */
	const patchToolCard = useCallback(
		(
			assistantId: string,
			callId: string,
			patch: (tool: ToolCardState) => ToolCardState,
		) => {
			patchAssistant(assistantId, (message) => ({
				...message,
				parts: (message.parts ?? []).map((part) =>
					part.type === "tool" && part.tool.callId === callId
						? { ...part, tool: patch(part.tool) }
						: part,
				),
			}));
		},
		[patchAssistant],
	);

	/** Agent-mode send: system prompt with the live folder tree, the full
	 * multi-turn tool transcript, and per-change Apply/Skip confirmation. */
	const sendAgent = useCallback(
		async (
			query: string,
			images: ImageAttachment[],
			assistantId: string,
			controller: AbortController,
		) => {
			const settings = plugin.settings;
			const folderTree = renderFolderTree(app.vault.getRoot(), {
				maxDepth: AGENT_TREE_DEPTH,
				maxEntries: AGENT_TREE_ENTRIES,
			});

			let filingGuide: string | undefined;
			const guidePath = settings.filingGuideNote.trim();
			if (guidePath.length > 0) {
				const guideFile = app.vault.getAbstractFileByPath(
					normalizePath(guidePath),
				);
				if (guideFile instanceof TFile) {
					try {
						filingGuide = (await app.vault.cachedRead(guideFile))
							.slice(0, AGENT_GUIDE_CHARS)
							.trim();
					} catch {
						// Unreadable guide — the prompt degrades cleanly without it.
					}
				}
			}

			const userContent: string | ContentPart[] =
				images.length > 0
					? [
							...(query.length > 0
								? [{ type: "text", text: query } as ContentPart]
								: []),
							...toContentParts(images),
						]
					: query;

			const userAgentMessage: AgentMessage = {
				role: "user",
				content: userContent,
			};
			const transcript: AgentMessage[] = [
				{
					role: "system",
					content: buildAgentSystemPrompt({
						folderTree,
						filingGuide,
						settings,
					}),
				},
				...agentTranscriptRef.current,
				userAgentMessage,
			];

			const executor = new VaultToolExecutor(app, settings, plugin.vaultIndex);

			const appendPart = (part: MessagePart) => {
				patchAssistant(assistantId, (message) => ({
					...message,
					parts: [...(message.parts ?? []), part],
				}));
			};

			// Images route through the vision task-model pair (its own provider);
			// agent turns keep tools either way — VL is tool-trained, and
			// ToolsUnsupportedError already degrades to the RAG pipeline below.
			const resolvedModel =
				images.length > 0
					? resolveTaskModel(settings, "vision")
					: {
							providerId: settings.activeProvider,
							model: settings.activeModel,
						};

			const result = await runAgentLoop({
				provider: getProviderFor(resolvedModel.providerId, settings),
				model: resolvedModel.model,
				messages: transcript,
				tools: TOOL_DEFINITIONS,
				executor,
				stream: settings.streamResponses,
				sampling: resolveSampling(settings),
				signal: controller.signal,
				events: {
					onToken: (token) => {
						patchAssistant(assistantId, (message) => {
							const parts = [...(message.parts ?? [])];
							const last = parts[parts.length - 1];
							if (last?.type === "text") {
								parts[parts.length - 1] = {
									type: "text",
									text: last.text + token,
								};
							} else {
								parts.push({ type: "text", text: token });
							}
							return { ...message, parts };
						});
					},
					onToolCall: (call, mutating) => {
						appendPart({
							type: "tool",
							tool: {
								callId: call.id,
								name: call.name,
								summary: executor.describeCall(
									call.name,
									(() => {
										try {
											return JSON.parse(call.arguments) as Record<
												string,
												unknown
											>;
										} catch {
											return {};
										}
									})(),
								),
								detail: mutating ? toolDetail(call.arguments) : undefined,
								mutating,
								status: mutating ? "awaiting" : "running",
							},
						});
					},
					requestConfirmation: (call) =>
						new Promise((resolve) => {
							confirmResolversRef.current.set(call.id, resolve);
						}),
					onToolResult: (call, result, status) => {
						confirmResolversRef.current.delete(call.id);
						patchToolCard(assistantId, call.id, (tool) => ({
							...tool,
							status:
								status === "skipped"
									? "skipped"
									: status === "capped"
										? "capped"
										: result.isError
											? "error"
											: tool.mutating
												? "applied"
												: "done",
							resultPreview:
								result.content.length > TOOL_PREVIEW_CHARS
									? `${result.content.slice(0, TOOL_PREVIEW_CHARS)}…`
									: result.content,
						}));
					},
				},
			});

			// Persist the turn for multi-turn context (system prompt excluded —
			// it's rebuilt fresh, with a live tree, on every send).
			agentTranscriptRef.current = [
				...agentTranscriptRef.current,
				userAgentMessage,
				...result.appended,
			];

			patchAssistant(assistantId, (message) => {
				// Agent-mode messages render from `parts`, not `content`. When the
				// final answer arrives non-streamed (onToken never fired — e.g.
				// streaming disabled or a provider that falls back to a whole-body
				// response), `parts` has no text part and the answer would be
				// silently dropped from the UI. Mirror onToken: ensure the final
				// text lands in `parts` so it actually renders.
				if (!message.parts) {
					return { ...message, content: result.text };
				}
				const parts = [...message.parts];
				const last = parts[parts.length - 1];
				if (last?.type === "text") {
					parts[parts.length - 1] = { type: "text", text: result.text };
				} else if (result.text.length > 0) {
					parts.push({ type: "text", text: result.text });
				}
				return { ...message, content: result.text, parts };
			});
		},
		[app, plugin, patchAssistant, patchToolCard],
	);

	const handleSend = useCallback(async () => {
		const query = input.trim();
		const images = imageAttachments;
		if ((!query && images.length === 0) || isSending) return;

		setInput("");
		setImageAttachments([]);
		setError(null);

		const history: ChatMessage[] = messages
			.filter((m) => !m.isError)
			.map((m) => ({ role: m.role, content: m.content }));

		const userMessage: FlintMessage = {
			id: nextId(),
			role: "user",
			content: query,
			...(images.length > 0 ? { images } : {}),
		};
		const assistantId = nextId();
		const assistantMessage: FlintMessage = {
			id: assistantId,
			role: "assistant",
			content: "",
			...(agentMode ? { parts: [] } : {}),
		};

		setMessages((prev) => [...prev, userMessage, assistantMessage]);
		setIsSending(true);

		const controller = new AbortController();
		abortRef.current = controller;

		try {
			if (agentMode) {
				try {
					await sendAgent(query, images, assistantId, controller);
					return;
				} catch (err) {
					if (!(err instanceof ToolsUnsupportedError)) throw err;
					// Model can't do tools — tell the user once and degrade to the
					// read-only RAG pipeline for this send.
					new Notice(
						`Flint: ${plugin.settings.activeModel} doesn't support tools — answering read-only. Pick a function-calling model for agent mode.`,
						8000,
					);
					patchAssistant(assistantId, (message) => ({
						...message,
						parts: undefined,
					}));
				}
			}

			const result = await runPipeline(
				query,
				plugin.settings,
				plugin.vaultIndex,
				{
					history,
					stream: plugin.settings.streamResponses,
					signal: controller.signal,
					pinnedPaths: attachments.map((file) => file.path),
					app,
					images: toContentParts(images),
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
							? { ...m, content: message, isError: true, parts: undefined }
							: m,
					),
				);
			}
		} finally {
			setIsSending(false);
			abortRef.current = null;
		}
	}, [
		input,
		imageAttachments,
		isSending,
		messages,
		plugin,
		attachments,
		app,
		agentMode,
		sendAgent,
		patchAssistant,
	]);

	return (
		<div className="flint-panel">
			<div className="flint-header">
				<span className="flint-title">Flint</span>
				<button
					type="button"
					className="flint-test-btn"
					onClick={() => void handleTestConnection()}
					disabled={testStatus === "testing"}
				>
					{testStatus === "testing" ? "Testing…" : "Test"}
				</button>
			</div>

			{testStatus !== "idle" && (
				<div className={`flint-test-status flint-test-${testStatus}`}>
					{testMessage}
				</div>
			)}

			<div className="flint-messages" ref={listRef}>
				{messages.length === 0 && (
					<Suggestions onSeed={(text) => setInput(text)} />
				)}
				{messages.map((m) => (
					<div
						key={m.id}
						className={`flint-message flint-message-${m.role}${m.isError ? " flint-message-error" : ""}`}
					>
						{m.role === "assistant" ? (
							m.parts ? (
								<div className="flint-parts">
									{m.parts.length === 0 && <div>…</div>}
									{m.parts.map((part, index) =>
										part.type === "text" ? (
											<AssistantMarkdown
												// biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only within a message.
												key={`${m.id}-part-${index}`}
												content={part.text}
											/>
										) : (
											<ToolCard
												key={part.tool.callId}
												tool={part.tool}
												onDecide={handleToolDecision}
											/>
										),
									)}
								</div>
							) : (
								<AssistantMarkdown content={m.content || "…"} />
							)
						) : (
							<div className="flint-user-text">
								{m.content}
								{m.images && m.images.length > 0 && (
									<div className="flint-image-chips">
										{m.images.map((image, index) => (
											<img
												// biome-ignore lint/suspicious/noArrayIndexKey: images are immutable per message.
												key={`${m.id}-img-${index}`}
												className="flint-image-thumb"
												src={`data:${image.mimeType};base64,${image.base64}`}
												alt={image.name}
											/>
										))}
									</div>
								)}
							</div>
						)}
						{m.citations && m.citations.length > 0 && (
							<Citations paths={m.citations} />
						)}
					</div>
				))}
			</div>

			{error && <div className="flint-error">{error}</div>}

			<div className="flint-composer">
				{imageAttachments.length > 0 && (
					<div className="flint-image-chips">
						{imageAttachments.map((image, index) => (
							<span
								// biome-ignore lint/suspicious/noArrayIndexKey: chips track a small reorder-free list.
								key={`pending-img-${index}`}
								className="flint-image-chip"
							>
								<img
									className="flint-image-thumb"
									src={`data:${image.mimeType};base64,${image.base64}`}
									alt={image.name}
								/>
								<button
									type="button"
									className="flint-attachment-remove"
									onClick={() => handleRemoveImage(index)}
									aria-label={`Remove ${image.name}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}
				{attachments.length > 0 && (
					<div className="flint-attachments">
						{attachments.map((file) => (
							<span key={file.path} className="flint-attachment-chip">
								{file.basename}
								<button
									type="button"
									className="flint-attachment-remove"
									onClick={() => handleRemoveAttachment(file.path)}
									aria-label={`Remove ${file.basename}`}
								>
									×
								</button>
							</span>
						))}
					</div>
				)}

				<div className="flint-model-row">
					<button
						type="button"
						className="flint-attach-btn"
						onClick={handleAttach}
						disabled={attachments.length >= MAX_ATTACHMENTS}
						title={
							attachments.length >= MAX_ATTACHMENTS
								? `Up to ${MAX_ATTACHMENTS} attached notes at once`
								: "Attach a note as a reference"
						}
					>
						+
					</button>
					<button
						type="button"
						className={`flint-agent-toggle${agentMode ? " flint-agent-on" : ""}`}
						onClick={() => updateAgentMode(!agentMode)}
						title={
							agentMode
								? "Agent mode: Flint can read and (with your approval) modify notes"
								: "Read-only mode: Flint answers from vault excerpts"
						}
					>
						Agent
					</button>
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
					<div className="flint-model-group">
						<input
							ref={modelInputRef}
							className="flint-model-input"
							type="text"
							placeholder="model id"
							value={model}
							onChange={(event) => updateModel(event.target.value)}
						/>
						<button
							type="button"
							className="flint-refresh-btn"
							onClick={() => void loadModels(true)}
							disabled={modelStatus === "loading"}
							title={
								modelStatus === "error" ? modelError : "Refresh model list"
							}
						>
							↻
						</button>
					</div>
				</div>

				{modelStatus === "error" && (
					<div className="flint-test-status flint-test-error">
						{modelError || "Couldn't load model list — using free text."}
					</div>
				)}

				<div className="flint-input-row">
					<textarea
						className="flint-input"
						placeholder="Ask your vault..."
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onPaste={handlePaste}
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
							disabled={!input.trim() && imageAttachments.length === 0}
						>
							Send
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

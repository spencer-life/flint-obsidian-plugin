import { Modal, Notice, normalizePath, TFile } from "obsidian";
import type FlintPlugin from "../main";
import { chatWithTaskModel } from "../providers";
import { appendUnderHeading, NEXT_STEPS_HEADING, removeBullets } from "./apply";
import {
	extractBullets,
	type InboxBullet,
	parseTriageResponse,
	type TriageClassification,
	validateTriageBatch,
} from "./parse";
import { buildTriagePrompt, type TriageTracker } from "./prompt";

/** A single item's bullet plus where it lives, before classification. */
interface SourcedBullet {
	inboxPath: string;
	bullet: InboxBullet;
}

/** A fully-resolved routing decision, ready to apply (or skip, if unsorted). */
export interface ProposedMove {
	inboxPath: string;
	bullet: InboxBullet;
	nextStep: string;
	/** Vault path of the note the task line gets appended to. */
	targetPath: string;
	/** Human-readable label shown in the review modal. */
	targetLabel: string;
}

/** Everything a triage pass produced: what to move, and what to leave alone. */
export interface TriagePlan {
	moves: ProposedMove[];
	unsortedCount: number;
}

/**
 * Reads the configured inbox notes, discovers project trackers, asks the
 * active provider to classify every capture bullet in one batched call, and
 * returns a plan of proposed moves. Never writes to the vault — that's
 * `applyTriagePlan`'s job, gated behind explicit confirmation.
 */
export class TriageService {
	constructor(private plugin: FlintPlugin) {}

	private get app() {
		return this.plugin.app;
	}

	discoverTrackers(): TriageTracker[] {
		const folder = normalizePath(this.plugin.settings.projectsFolder);
		return this.app.vault
			.getMarkdownFiles()
			.filter(
				(file) =>
					(file.path === folder || file.path.startsWith(`${folder}/`)) &&
					!file.basename.startsWith("_"),
			)
			.map((file) => ({ path: file.path, name: file.basename }));
	}

	private async readSourcedBullets(): Promise<SourcedBullet[]> {
		const sourced: SourcedBullet[] = [];
		for (const rawPath of this.plugin.settings.inboxNotes) {
			const path = normalizePath(rawPath);
			const file = this.app.vault.getFileByPath(path);
			if (!(file instanceof TFile)) continue;
			const content = await this.app.vault.cachedRead(file);
			for (const bullet of extractBullets(content)) {
				sourced.push({ inboxPath: path, bullet });
			}
		}
		return sourced;
	}

	/** Resolves which note a classification's `target` should append to. */
	private resolveTargetPath(
		target: string,
		trackers: TriageTracker[],
	): { path: string; label: string } | null {
		if (target === "unsorted") return null;

		if (target === "ideas") {
			const ideasPath = this.plugin.settings.inboxNotes.find((p) =>
				p.toLowerCase().includes("ideas"),
			);
			const path = normalizePath(
				ideasPath ?? this.plugin.settings.inboxNotes[0] ?? "",
			);
			return path ? { path, label: "Ideas" } : null;
		}

		const normalizedTarget = normalizePath(target);
		const tracker = trackers.find(
			(t) =>
				t.path === normalizedTarget ||
				t.name.toLowerCase() === target.trim().toLowerCase(),
		);
		return tracker ? { path: tracker.path, label: tracker.name } : null;
	}

	/** Runs classification and builds a proposed plan. Read-only. */
	async buildPlan(): Promise<TriagePlan | null> {
		const sourced = await this.readSourcedBullets();
		if (sourced.length === 0) return null;

		const trackers = this.discoverTrackers();
		const messages = buildTriagePrompt(
			sourced.map((s) => s.bullet.item),
			trackers,
		);

		const raw = await chatWithTaskModel(
			this.plugin.settings,
			"triage",
			messages,
		);

		let classifications: TriageClassification[];
		try {
			classifications = parseTriageResponse(raw);
			validateTriageBatch(
				classifications,
				sourced.map((s) => s.bullet.item),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(message);
			return null;
		}

		const moves: ProposedMove[] = [];
		let unsortedCount = 0;

		sourced.forEach((entry, i) => {
			const classification = classifications[i];
			if (!classification) return;

			const resolved = this.resolveTargetPath(classification.target, trackers);
			if (!resolved) {
				unsortedCount++;
				return;
			}

			moves.push({
				inboxPath: entry.inboxPath,
				bullet: entry.bullet,
				nextStep: classification.nextStep,
				targetPath: resolved.path,
				targetLabel: resolved.label,
			});
		});

		return { moves, unsortedCount };
	}

	/** Applies a confirmed plan: appends tasks, then removes routed bullets. */
	async applyPlan(plan: TriagePlan): Promise<void> {
		const byTarget = new Map<string, string[]>();
		for (const move of plan.moves) {
			const line = `- [ ] ${move.nextStep} (from: ${move.bullet.item})`;
			const lines = byTarget.get(move.targetPath) ?? [];
			lines.push(line);
			byTarget.set(move.targetPath, lines);
		}

		for (const [targetPath, lines] of byTarget) {
			const file = this.app.vault.getFileByPath(targetPath);
			if (!(file instanceof TFile)) continue;
			await this.app.vault.process(file, (data) =>
				appendUnderHeading(data, NEXT_STEPS_HEADING, lines),
			);
		}

		const byInbox = new Map<string, string[]>();
		for (const move of plan.moves) {
			const raws = byInbox.get(move.inboxPath) ?? [];
			raws.push(move.bullet.raw);
			byInbox.set(move.inboxPath, raws);
		}

		for (const [inboxPath, rawLines] of byInbox) {
			const file = this.app.vault.getFileByPath(inboxPath);
			if (!(file instanceof TFile)) continue;
			await this.app.vault.process(file, (data) =>
				removeBullets(data, rawLines),
			);
		}

		new Notice(`Flint: routed ${plan.moves.length} item(s) from your inbox.`);
	}

	/** "Triage inbox" command: builds a plan, then confirms via modal before applying. */
	async runManual(): Promise<void> {
		new Notice("Flint: triaging inbox...");
		const plan = await this.buildPlanSafely();
		if (!plan) return;

		if (plan.moves.length === 0) {
			new Notice("Flint: nothing new to triage.");
			return;
		}

		new TriageReviewModal(this.plugin, plan, () => {
			void this.applyPlan(plan);
		}).open();
	}

	/**
	 * Interval-driven pass. Only auto-applies when `autoTriageAutoApply` is
	 * set — otherwise it just surfaces a Notice so nothing destructive ever
	 * happens without the user opening the review modal (or opting in).
	 */
	async runAuto(): Promise<void> {
		const plan = await this.buildPlanSafely();
		if (!plan || plan.moves.length === 0) return;

		if (this.plugin.settings.autoTriageAutoApply) {
			await this.applyPlan(plan);
			return;
		}

		new Notice(`Flint: ${plan.moves.length} item(s) ready to triage.`);
	}

	private async buildPlanSafely(): Promise<TriagePlan | null> {
		try {
			return await this.buildPlan();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Flint: triage failed — ${message}`);
			return null;
		}
	}
}

/** Dry-run confirmation modal: lists every proposed move before anything is written. */
class TriageReviewModal extends Modal {
	constructor(
		plugin: FlintPlugin,
		private plan: TriagePlan,
		private onConfirm: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: "Flint: review triage" });

		if (this.plan.unsortedCount > 0) {
			contentEl.createEl("p", {
				text: `${this.plan.unsortedCount} item(s) couldn't be confidently routed and will stay in the inbox.`,
			});
		}

		const list = contentEl.createEl("ul");
		for (const move of this.plan.moves) {
			const li = list.createEl("li");
			li.createEl("strong", { text: move.bullet.item });
			li.createSpan({ text: ` → ${move.targetLabel}` });
			li.createEl("div", { text: move.nextStep });
		}

		const buttons = contentEl.createDiv();
		const confirmButton = buttons.createEl("button", { text: "Confirm" });
		confirmButton.addEventListener("click", () => {
			this.onConfirm();
			this.close();
		});

		const cancelButton = buttons.createEl("button", { text: "Cancel" });
		cancelButton.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

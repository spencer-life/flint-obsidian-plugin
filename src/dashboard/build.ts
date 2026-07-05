/**
 * Pure logic for the daily dashboard note: mtime windowing, "Next small
 * steps" extraction from project trackers, and note template assembly. No
 * `obsidian` imports here so this module stays unit-testable without the
 * Obsidian runtime — every function takes its clock as an argument rather
 * than calling `Date.now()`/`new Date()` itself.
 */

import { isMatchingHeading, NEXT_STEPS_HEADING } from "../triage/apply";

const MS_PER_HOUR = 60 * 60 * 1000;
const WINDOW_HOURS = 48;

/** How many unchecked next-steps to surface per tracker. */
const MAX_STEPS_PER_TRACKER = 3;

const HEADING_LINE = /^#{1,6}\s/;
const UNCHECKED_TASK_LINE = /^-\s*\[\s\]\s*(.+)$/;

/** Minimal shape `build.ts` needs from a vault file — just enough to window
 * by mtime without an `obsidian` import. */
export interface DashboardFile {
	path: string;
	stat: { mtime: number };
}

/**
 * Files modified within the last 48 hours (as of `now`), excluding files
 * under any configured exclude folder and skipping the Daily folder itself
 * (so the dashboard never lists its own past notes as "changed").
 */
export function filterRecentFiles<T extends DashboardFile>(
	files: T[],
	now: number,
	excludeFolders: string[],
	dailyFolder: string,
): T[] {
	const cutoff = now - WINDOW_HOURS * MS_PER_HOUR;

	const isExcluded = (path: string) =>
		excludeFolders.some(
			(folder) => path === folder || path.startsWith(`${folder}/`),
		) ||
		path === dailyFolder ||
		path.startsWith(`${dailyFolder}/`);

	return files
		.filter((file) => file.stat.mtime >= cutoff && !isExcluded(file.path))
		.sort((a, b) => b.stat.mtime - a.stat.mtime);
}

/**
 * Extracts up to `MAX_STEPS_PER_TRACKER` unchecked `- [ ]` items from a
 * tracker note's `## Next small steps` section (matched with or without a
 * leading emoji, via `apply.ts`'s normalized heading matcher — reused here
 * rather than re-implemented). Returns an empty array if the note has no
 * such heading or no unchecked items under it.
 */
export function extractNextSteps(content: string): string[] {
	const lines = content.split(/\r?\n/);
	const headingIndex = lines.findIndex((line) =>
		isMatchingHeading(line, NEXT_STEPS_HEADING),
	);
	if (headingIndex === -1) return [];

	const steps: string[] = [];
	for (let i = headingIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (HEADING_LINE.test(line)) break;

		const match = line.trim().match(UNCHECKED_TASK_LINE);
		if (match?.[1]) {
			steps.push(match[1].trim());
			if (steps.length >= MAX_STEPS_PER_TRACKER) break;
		}
	}

	return steps;
}

/** A single tracker's surfaced next steps, keyed by its display name. */
export interface TrackerSteps {
	name: string;
	steps: string[];
}

/** A single changed file, as surfaced in the dashboard's changes section. */
export interface DashboardChangedFile {
	path: string;
	mtime: number;
}

/** Everything needed to render one day's dashboard note. */
export interface DashboardData {
	/** Local `YYYY-MM-DD` date the note is for. */
	date: string;
	changedFiles: DashboardChangedFile[];
	trackerSteps: TrackerSteps[];
	/** The AI narrative summary, or `null` when the LLM call failed/was
	 * skipped — rendered as a degraded placeholder rather than omitted. */
	summary: string | null;
}

/** Local (not UTC) `YYYY-MM-DD` for `date` — the dashboard's file naming and
 * "today" checks always use the user's local day boundary. */
export function localDateString(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/**
 * Assembles the full dashboard note markdown from its deterministic sections
 * (changed files, tracker next-steps) plus the optional AI summary. The
 * deterministic sections render "Nothing captured." when empty rather than
 * being omitted — an empty day still produces a predictable note.
 */
export function buildDailyNote(data: DashboardData): string {
	const lines: string[] = [`# Daily dashboard — ${data.date}`, ""];

	lines.push("## Summary", "");
	lines.push(
		data.summary && data.summary.trim().length > 0
			? data.summary.trim()
			: "Summary unavailable.",
	);
	lines.push("");

	lines.push("## Changed in the last 48 hours", "");
	if (data.changedFiles.length === 0) {
		lines.push("Nothing captured.");
	} else {
		for (const file of data.changedFiles) {
			lines.push(`- ${file.path}`);
		}
	}
	lines.push("");

	lines.push("## Next small steps", "");
	const trackersWithSteps = data.trackerSteps.filter(
		(tracker) => tracker.steps.length > 0,
	);
	if (trackersWithSteps.length === 0) {
		lines.push("Nothing captured.");
	} else {
		for (const tracker of trackersWithSteps) {
			lines.push(`### ${tracker.name}`);
			for (const step of tracker.steps) {
				lines.push(`- [ ] ${step}`);
			}
			lines.push("");
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

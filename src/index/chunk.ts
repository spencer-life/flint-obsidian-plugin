export interface VaultChunk {
	id: string;
	path: string;
	heading: string;
	text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Minimum/target chunk size, in words, before splitting a section further. */
const MAX_WORDS = 600;

interface Section {
	heading: string;
	body: string;
}

function splitIntoSections(content: string): Section[] {
	const lines = content.split(/\r?\n/);
	const sections: { heading: string; lines: string[] }[] = [
		{ heading: "", lines: [] },
	];

	for (const line of lines) {
		const match = line.match(HEADING_RE);
		if (match) {
			sections.push({ heading: (match[2] ?? "").trim(), lines: [] });
		} else {
			sections[sections.length - 1]?.lines.push(line);
		}
	}

	return sections
		.map((section) => ({
			heading: section.heading,
			body: section.lines.join("\n").trim(),
		}))
		.filter((section) => section.body.length > 0 || section.heading.length > 0);
}

function chunkByWords(
	path: string,
	heading: string,
	text: string,
	idOffset: number,
): VaultChunk[] {
	const words = text.split(/\s+/).filter(Boolean);
	if (words.length === 0) return [];

	if (words.length <= MAX_WORDS) {
		return [{ id: `${path}#${idOffset}`, path, heading, text }];
	}

	const chunks: VaultChunk[] = [];
	for (
		let i = 0, chunkIndex = 0;
		i < words.length;
		i += MAX_WORDS, chunkIndex++
	) {
		chunks.push({
			id: `${path}#${idOffset + chunkIndex}`,
			path,
			heading,
			text: words.slice(i, i + MAX_WORDS).join(" "),
		});
	}
	return chunks;
}

/**
 * Splits a note's markdown content into retrieval chunks: first by heading,
 * then by ~600-word windows for any section too long to embed/search as one
 * unit. Notes with no headings become a single implicit section.
 */
export function chunkNote(path: string, content: string): VaultChunk[] {
	const sections = splitIntoSections(content);
	const chunks: VaultChunk[] = [];
	let idOffset = 0;

	for (const section of sections) {
		const sectionChunks = chunkByWords(
			path,
			section.heading,
			section.body,
			idOffset,
		);
		chunks.push(...sectionChunks);
		idOffset += Math.max(sectionChunks.length, 1);
	}

	return chunks;
}

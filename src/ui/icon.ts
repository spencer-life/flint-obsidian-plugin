import { addIcon } from "obsidian";

/**
 * Flint's flame-with-spark mark. Obsidian wraps `addIcon` content in a
 * 0 0 100 100 viewBox; stroke-only + `currentColor` keeps it crisp and
 * theme-adaptive anywhere it lands (ribbon, view tab, command palette),
 * matching Lucide's stroke conventions at this scale.
 */
const FLINT_FLAME_SVG = `
<g fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">
  <path d="M50 12 C 50 30, 26 38, 26 62 a 24 24 0 0 0 48 0 C 74 44, 58 38, 56 22 C 55 17, 52 14, 50 12 Z"/>
  <path d="M50 88 a 14 14 0 0 1 -14 -14 c 0 -10 8 -13 14 -22 c 6 9 14 12 14 22 a 14 14 0 0 1 -14 14 Z" stroke-width="6"/>
</g>`;

export const FLINT_ICON_ID = "flint-flame";

export function registerFlintIcon(): void {
	addIcon(FLINT_ICON_ID, FLINT_FLAME_SVG);
}

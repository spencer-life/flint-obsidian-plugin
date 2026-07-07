import { TFile, type Vault } from "obsidian";

/** Vault-root note that receives one line per Flint-applied change. */
export const FLINT_LOG_PATH = "Flint Log.md";

const LOG_HEADER =
	"# Flint Log\n\nChanges applied by Flint (newest at the bottom).\n\n";

/**
 * Appends one line to the vault-root activity log. Best-effort only — a
 * failure here must never break the change that already happened. Handles
 * the create race (two concurrent appends both finding no log) by falling
 * back to append when create collides. Shared by the organize pipeline and
 * the chat agent's mutating tools.
 */
export async function appendFlintLog(
	vault: Vault,
	line: string,
): Promise<void> {
	try {
		const existing = vault.getAbstractFileByPath(FLINT_LOG_PATH);
		if (existing instanceof TFile) {
			await vault.process(existing, (data) => `${data.trimEnd()}\n${line}\n`);
		} else if (existing === null) {
			try {
				await vault.create(FLINT_LOG_PATH, `${LOG_HEADER}${line}\n`);
			} catch {
				// Create collision: a concurrent change created the log between
				// our lookup and create. Re-resolve and append instead so this
				// entry isn't lost.
				const raced = vault.getAbstractFileByPath(FLINT_LOG_PATH);
				if (raced instanceof TFile) {
					await vault.process(raced, (data) => `${data.trimEnd()}\n${line}\n`);
				}
			}
		}
	} catch {
		// Best-effort: never let logging break an applied change.
	}
}

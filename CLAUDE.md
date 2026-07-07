# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flint — Spencer's personal Obsidian plugin (TypeScript + React 19, esbuild via Bun). AI chat over the vault (read-only RAG + tool-calling agent mode), web-clip ingest/organize, triage, daily dashboards.

## Commands

- Build: `bun run build` (runs `tsc -noEmit` then esbuild; must exit 0 before any deploy)
- Test: `bun test` (all), `bun test <file-substring>` (one file)
- Deploy: `just --yes flint_deploy` (build → `just vault_sync` pull → copy `main.js`/`manifest.json`/`styles.css` into `../flint-main/.obsidian/plugins/flint/` → sync push → `obsidian plugin:reload id=flint`). `just flint_deploy_shot` adds a desktop screenshot.

## Hard rules

- **NEVER write the deployed `data.json`** (in the vault plugin dir). The running app holds settings in memory and overwrites file edits. Settings changes ship as code: bump `SETTINGS_VERSION` and extend `loadSettingsFromRaw` in `src/settings.ts` — migration decisions run on the RAW `loadData()` blob, before defaults merge.
- The live vault's WSL copy is `../flint-main/`; never touch the Windows-side vault path directly (read-only checks via `/mnt/c/Users/MLPC/Documents/Flint Main/` are fine).
- All vault writes go through Obsidian `Vault`/`FileManager` APIs (never `fs`); moves via `fileManager.renameFile` so backlinks survive.
- Agent security invariants (don't weaken): no delete tool; mutating tools confirm via Apply/Skip; moves validated by exact match against the live folder allowlist (`src/agent/vault-tree.ts`); tool results framed as untrusted; proposal bodies render as plain text, never `MarkdownRenderer`; LLM-suggested destinations are only trusted via allowlist membership (`src/triage/organize-parse.ts`).

## Deploy gotchas

- Obsidian Sync races `plugin:reload`: after the sync push, the Windows app pulls on its own schedule — verify the new `main.js` landed Windows-side (grep for a new-code marker) or wait ~20 s before reloading, else the OLD build reloads.
- The `obsidian` shim sometimes loses stdout over WSL interop — route through a `.cmd` in Windows Temp via `cmd.exe /c` (see the global `obsidian` skill).
- `obsidian dev:screenshot` can return stale frames; confirm UI state with `obsidian eval` (e.g. `app.plugins.plugins.flint.manifest.version`) before debugging from a screenshot.

## Tests

- The real `obsidian` package is types-only; `test/obsidian-mock.ts` replaces it via `mock.module` — import it FIRST in every test file, then `await import(...)` the code under test.
- `test/fake-vault.ts` `createFakeApp(files, {folders})` provides vault + folder tree + `fileManager` + `metadataCache`.
- Provider request bodies for plain string-content messages must stay byte-identical (regression tests in `test/providers-tools.test.ts`).

## Style (community-guideline compliance)

- UI copy: sentence case ("Apply selected", not "Apply Selected"); no `innerHTML`; icons stroke `currentColor`.
- Release bump: `manifest.json` version + matching entry in `versions.json`.

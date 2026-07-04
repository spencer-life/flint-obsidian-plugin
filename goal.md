# Flint — Goal

## The one-line goal

A **portable** Obsidian plugin that weaves AI + capture automation directly into the vault — self-contained (no reliance on Spencer's WSL setup), installable on **any device including mobile**, doing its work in its own bundled JavaScript over HTTP.

## Why this exists

Spencer captures constantly (web clipper, PC + mobile) into the Flint Main vault and has ADHD. He wants the vault to actively *help* — chat that knows his notes, clips that clean themselves up, an Inbox that sorts itself — without being chained to one machine or opening a desktop app he doesn't live in.

## Locked scope (from the roadmap, Ambitious tier)

Build order: **A → B → E → D**. NotebookLM (C) **skipped**. Everything portable (desktop + mobile).

- **A — Vault AI Panel** (core): right-sidebar chat that knows the vault. Multi-provider (NVIDIA NIM / Claude / Ollama / OpenAI). Vault-wide search index + top-k retrieval with citations (excludes `04 Dev Docs`). *Ambitious:* streaming where the provider allows it; local semantic embeddings with a lean-keyword fallback on mobile.
- **B — Web→Markdown Ingest**: new clips in `03 Clippings/` get tidied + frontmatter-stamped in-plugin; startup backlog scan; de-dupe/idempotency. *Ambitious:* on-demand re-fetch & clean of a source URL (requestUrl + Turndown, Firecrawl API fallback).
- **E — ADHD Capture Triage**: reads `00 Start/Inbox.md` + `Ideas.md`, categorizes, routes to the right `01 Projects/` tracker, drafts `## 👉 Next small steps`. *Ambitious:* interval + on-launch auto-triage.
- **D — Content Generation**: a note → viewable HTML page (via installed `obsidian-html-plugin`) or generated image (NIM). *Ambitious:* templated multi-asset generation.

## What "done" looks like (definition of done)

- Installs via BRAT on desktop **and** mobile; panel opens with no console errors (incl. under `app.emulateMobile(true)`).
- **A:** a prompt to NIM *and* to Claude returns an answer that cites a real note retrieved from the vault.
- **B:** a new clip becomes a tidy frontmatter note; a clip that arrived while closed is caught by the backlog scan.
- **E:** a seeded Inbox gets sorted under the correct project's next-steps.
- **D:** a note produces an HTML page / image opened in-app.

## Honest ceilings at the Ambitious tier

- **Streaming:** desktop yes; mobile depends on provider browser-origin CORS (Claude ok, NIM unconfirmed) → stream where allowed, full-response fallback elsewhere.
- **Embeddings:** heavy on phone → full local embeddings on desktop, lean keyword index on mobile.
- **Scheduling:** a plugin only runs while Obsidian is open (the tray app covers this) → interval + on-launch, not true closed-app cron.

## Architecture (portable, JS-native)

Pure-JavaScript plugin, `isDesktopOnly: false`. All external work via `requestUrl` (CORS-free HTTP) + bundled JS libs (Turndown for HTML→MD, a search lib for the index). **No `child_process`, no Python, no WSL, no external scripts.** Provider layer: one OpenAI-compatible client (NIM/Ollama/OpenAI) + a dedicated Claude adapter. Writes notes into the vault → Obsidian Sync fans them to every device.

## Distribution

Own GitHub repo → install via **BRAT** (auto-updates), any device. Later: optional community-store submission.

## Non-goals

- No NotebookLM (unofficial, non-portable, no audio/video).
- No reliance on WSL CLIs from inside the plugin.
- Not architected around a Claude Code OAuth token (unsupported) — Anthropic API key only.

---
*Living doc — updated as phases land. Full build plan: `.claude/plans/flint-portable-plugin.md`.*

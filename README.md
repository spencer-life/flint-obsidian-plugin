# Flint

Portable AI + capture automation woven into your Obsidian vault. Chat with an assistant that retrieves and cites your own notes, from a right-sidebar panel — on desktop and mobile.

## Features

- **Vault AI panel** — a sidebar chat that searches your vault (top-k retrieval with citations) and answers grounded in your notes. Answers cite the notes they used; click a citation to open the note.
- **Multi-provider** — bring your own API key for Anthropic (Claude), NVIDIA NIM, OpenAI, or a local Ollama server. Switch provider and model in settings or from the panel.
- **Streaming replies** where the provider allows it, with automatic fallback to full responses.
- Fully portable: no Node/Electron APIs, works on desktop **and** mobile.

## Network use disclosure

This plugin makes network requests only to services you've configured, and only when you trigger one of the actions below. There is no telemetry, analytics, or background tracking of any kind.

| Trigger | Destination | Data sent |
| --- | --- | --- |
| Vault AI panel chat / "Test" button | Your active provider: `https://api.anthropic.com` (Anthropic), `https://integrate.api.nvidia.com` (NVIDIA NIM), your configured base URL (OpenAI/compatible), or your configured local server (Ollama, e.g. `http://localhost:11434`) | Your chat message, recent conversation turns, and short excerpts of vault notes retrieved as context |
| "Refetch clip source" command | The clip's own `source` URL (whatever site it was clipped from), plus `https://api.firecrawl.dev` as an optional fallback when a Firecrawl API key is configured | The source URL itself (a GET request); the URL and your Firecrawl key (to Firecrawl only, on fallback) |
| "Triage inbox" (manual or scheduled auto-triage) | Your active provider (as above) | The text of your inbox capture items and the names of your project tracker notes |
| "Generate HTML/image page from note" commands | Your active provider (for the page/visual-prompt text) and your configured image provider (NVIDIA NIM or OpenAI, for the image itself) | The full content of the note being turned into a page/image |

API keys are sent only to the provider/service they belong to — never to any other destination.

## API keys

API keys are supplied by you in the plugin settings and stored in the plugin's local `data.json` inside your vault's `.obsidian` folder (standard for Obsidian plugins). Note: if your vault syncs (e.g. Obsidian Sync), that file syncs with it. Never share your vault config folder publicly with keys present.

## Install

Not yet in the community plugin store. Install from a GitHub release: copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/flint/`, then enable Flint in Settings → Community plugins. (Or use BRAT with this repo to get auto-updates.)

## License

MIT

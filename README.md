# Flint

Portable AI + capture automation woven into your Obsidian vault. Chat with an assistant that retrieves and cites your own notes, from a right-sidebar panel — on desktop and mobile.

## Features

- **Vault AI panel** — a sidebar chat that searches your vault (top-k retrieval with citations) and answers grounded in your notes. Answers cite the notes they used; click a citation to open the note.
- **Multi-provider** — bring your own API key for Anthropic (Claude), NVIDIA NIM, OpenAI, or a local Ollama server. Switch provider and model in settings or from the panel.
- **Streaming replies** where the provider allows it, with automatic fallback to full responses.
- Fully portable: no Node/Electron APIs, works on desktop **and** mobile.

## Network use disclosure

This plugin makes network requests **only** to the AI provider you configure, and only when you send a message (or test the connection):

- **Anthropic** — `https://api.anthropic.com` (when Claude is the active provider)
- **NVIDIA NIM** — `https://integrate.api.nvidia.com` (when NIM is the active provider)
- **OpenAI or compatible** — the base URL you configure (when active)
- **Ollama** — your configured local server URL, e.g. `http://localhost:11434` (when active)

What is sent: your chat message, recent conversation turns, and short excerpts of vault notes retrieved as context for your question. Nothing is sent anywhere else; there is no telemetry, analytics, or tracking of any kind.

## API keys

API keys are supplied by you in the plugin settings and stored in the plugin's local `data.json` inside your vault's `.obsidian` folder (standard for Obsidian plugins). Note: if your vault syncs (e.g. Obsidian Sync), that file syncs with it. Never share your vault config folder publicly with keys present.

## Install

Not yet in the community plugin store. Install from a GitHub release: copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/flint/`, then enable Flint in Settings → Community plugins. (Or use BRAT with this repo to get auto-updates.)

## License

MIT

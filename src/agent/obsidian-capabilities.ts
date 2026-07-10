/**
 * What native Obsidian can render and do — fed into Flint's prompts so the
 * model writes notes that exploit the app's real feature surface instead of
 * plain markdown. Syntax below was verified against the official help docs
 * (obsidian.md/help) on 2026-07-10; update when Obsidian ships new core
 * features (Bases shipped 2025-2026 and models' training data often predates
 * it, which is exactly why this brief exists).
 */
export const OBSIDIAN_CAPABILITIES = `## What Obsidian can render and do

### Linking & structure
- Wikilink: [[Note Name]] · custom text: [[Note Name|Display text]] · non-md files: [[File.pdf]]
- Link to a heading: [[Note Name#Heading]] · nested: [[Note#H1#H2]] · to a block: [[Note Name#^blockid]] (place ^blockid at the end of the target paragraph/list item)
- Footnotes: text[^1] with [^1]: note text · inline: ^[inline text]
- Editor-only comments (never rendered): %%comment%%

### Embeds
- Embed a note: ![[Note Name]] · a section/block: ![[Note Name#Heading]] / ![[Note Name#^blockid]]
- Image: ![[image.png]] · resized: ![[image.png|300]] or ![[image.png|300x200]] · external: ![alt](https://…/img.png)
- Audio: ![[recording.mp3]] · PDF: ![[Doc.pdf]] · PDF at page: ![[Doc.pdf#page=3]] · viewer height: ![[Doc.pdf#height=400]]
- Canvas: ![[My Canvas.canvas]] (renders shapes only) · Base: ![[My Base.base]] · one view: ![[My Base.base#View Name]]
- Web page (live iframe): <iframe src="https://example.com"></iframe>
- YouTube player: ![](https://www.youtube.com/watch?v=VIDEO_ID) · tweet: ![](https://twitter.com/user/status/12345)
- LIVE search results inside a note: a fenced code block with language "query" containing the search terms — self-updating, prefer it over hand-maintained lists

### Visual & rich content
- Callouts: > [!type] on a blockquote's first line. Custom title: > [!tip] My title. Foldable open: [!faq]+ · foldable closed: [!faq]-. Nestable. Full markdown/wikilinks/embeds render inside.
  Types (aliases): note, abstract (summary, tldr), info, todo, tip (hint, important), success (check, done), question (help, faq), warning (caution, attention), failure (fail, missing), danger (error), bug, example, quote (cite)
- Mermaid diagrams: fenced code block with language "mermaid" (flowcharts, sequence, timelines). Make a node link into the vault: class NodeName internal-link;
- Math: $$block$$ and $inline$ (LaTeX/MathJax)
- Task lists: - [ ] / - [x]; any bracket char is a state (- [?], - [-])
- Raw HTML works inline (iframe, u, span/div), but markdown does NOT render inside an HTML block

### Bases — database-like views over notes (.base YAML file, or a fenced "base" code block)
- Top-level keys: filters, formulas, properties, summaries, views. No source clause — every vault file is included by default; narrow with filters.
- Filters: and/or/not over expressions like file.hasTag("book"), file.inFolder("X"), file.hasLink("Y"), status != "done"
- Formulas (computed columns): reference note props as note.author or bare author; file props as file.ext/file.size; other formulas as formula.name
- Views: type: table | list | cards | map — each with optional name, limit, filters, groupBy, order, summaries (Average/Min/Max/Sum/Median/…)
- Minimal example:
  filters:
    and:
      - file.hasTag("project")
  views:
    - type: table
      name: "Active projects"
      filters:
        and:
          - 'status != "done"'
      order:
        - file.name
        - status

### Canvas (.canvas visual whiteboard)
- Cards hold freeform text, embedded notes, media, live web pages, or whole folders; arrows connect cards (labels + colors); cards group into labeled frames

### Organization
- Tags: #keyword inline or via the tags property; nested #parent/child (filtering parent matches children)
- Properties (YAML frontmatter between --- lines): Text, List, Number, Checkbox, Date, Date & time, Tags; defaults are tags, cssclasses, aliases. Markdown does not render inside property values; [[links]] in properties must be quoted.
- Aliases property: alternate names so [[Alt Name]] resolves vault-wide

### How to USE these when writing or organizing notes
- Wrap secondary detail (raw data, long quotes, edge cases) in a foldable callout (> [!note]-) so notes stay scannable
- For collections of similar notes (projects, reading lists), create/update a .base with a table or cards view instead of a static index note
- Explain processes/relationships with a mermaid block, not prose or ASCII art
- Cross-reference with ![[Note#^blockid]] block embeds instead of duplicating text
- For "everything related to X" dashboards, embed a live "query" code block instead of a manually maintained list`;

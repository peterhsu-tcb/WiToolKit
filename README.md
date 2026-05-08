# WeTools

This repository now contains a redesigned starter application named **WeTools**.

## What changed

Based on the upstream WiToolKit concept (multi-tool utility app), this redesign keeps the same high-level idea and introduces a simpler, clean dashboard experience with:

- File Manager
- Text Compare
- Media Converter
- PDF Text Extract
- Agentic Client

## Run

Open the redesigned app directly in a browser:

`WeTools/index.html`

## UI

- Sidebar + workspace layout, responsive down to mobile widths.
- Light/dark theme via `prefers-color-scheme` (no toggle yet).
- Design tokens in `:root` (`--bg`, `--surface`, `--border`, `--accent`, `--radius`).
- Accessible: `aria-pressed` selected state, visible focus ring, arrow-key navigation between tools, `aria-live` workspace.
- Inline SVG icon set (no emoji rendering inconsistencies); SVG favicon.

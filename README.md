# WeTools

This repository now contains a redesigned starter application named **WeTools**.

## What changed

Based on the upstream WiToolKit concept (multi-tool utility app), this redesign keeps the same high-level idea and introduces a simpler, clean dashboard experience with:

- File Manager
- Text Compare
- Media Converter
- PDF Text Extract
- Agentic Client
- Media Manager (new)

## Run

Open the redesigned app directly in a browser:

`WeTools/index.html`

## UI

- Sidebar + workspace layout, responsive down to mobile widths.
- Light/dark theme via `prefers-color-scheme` (no toggle yet).
- Design tokens in `:root` (`--bg`, `--surface`, `--border`, `--accent`, `--radius`).
- Accessible: `aria-pressed` selected state, visible focus ring, arrow-key navigation between tools, `aria-live` workspace.
- Inline SVG icon set (no emoji rendering inconsistencies); SVG favicon.

## Media Manager

A privacy-first, browser-only media workspace. **No history is recorded** — the
module never writes to `localStorage`, `sessionStorage`, `IndexedDB`, or
cookies, and never uploads files. Object URLs are revoked on teardown.

Sections:

- **Player** — drag-and-drop or pick an audio, image, or video file; renders the
  appropriate `<audio>`, `<img>`, or `<video controls>` element.
- **Subtitles** — load a sidecar `.srt`/`.vtt` (SRT is auto-converted to VTT and
  attached as a `<track>`); for in-band tracks click *Extract* to pull cues from
  `videoElement.textTracks` and download as `.vtt`. Browsers only expose
  in-band WebVTT tracks (typically MP4); for MKV/SRT/PGS the panel shows the
  exact `ffmpeg -map 0:s:0` command to run.
- **Voice to text** — Web Speech API mic transcription with language picker,
  start/stop/clear, and *Download .txt*. Includes a `whisper` command snippet
  for offline file-based transcription.
- **Cut audio / video** — `start`/`end` seconds (with *Use current* helpers).
  Audio is decoded with Web Audio, sliced, and re-encoded as 16-bit PCM WAV.
  Video uses `MediaRecorder` on `HTMLMediaElement.captureStream()` and saves
  WebM. A frame-accurate `ffmpeg -ss … -to … -c copy` snippet is included.
- **YouTube download** — builds an exact `yt-dlp` command for the largest
  resolution (`bv*+ba/b -S "res,br,fps"`) or best MP4-compatible / audio-only
  variant, with an optional `--write-subs` flag and a *Copy command* button.
  The URL never leaves your browser; you run the command in a terminal where
  `yt-dlp` (and `ffmpeg`) are installed.

External tools assumed for the snippet sections: `ffmpeg`, `yt-dlp`, `whisper`.

### Save As

Every output (cut audio WAV, cut video WebM, extracted VTT, transcript, and the
loaded source file via the Player's *Save as…* button) is routed through a
shared `saveAs(blob, suggestedName)` helper that:

1. Uses `window.showSaveFilePicker` (File System Access API) when available —
   the user picks the destination folder and filename in a native dialog, and
   the blob is streamed directly to the chosen handle.
2. Falls back to `window.prompt()` for the filename plus the standard
   anchor-based download (which respects the browser's "Always ask where to
   save each file" setting).

The helper is also exposed as `window.WeToolsSaveAs` for ad-hoc use.

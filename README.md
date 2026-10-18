# Grimcut

A simple Fluent-style video editor (ocenaudio vibe): drop a file, cut on a timeline, save.

Desktop app built with **Tauri 2 + React**, same family as [Grimpad](https://github.com/Grimstuff/grimpad). Local files only; FFmpeg does probe and export (stream copy on keyframe cuts, otherwise high-quality / GPU encode).

## Requirements

- Node 20+
- Rust (stable)
- Windows 10/11 + WebView2
- FFmpeg (dev: `.\scripts\fetch-ffmpeg.ps1`; testers: PATH or the in-app/installer prompt)

## Setup

```powershell
cd C:\Users\Grimmers\Dev\grimsuite\grimcut
npm install
.\scripts\fetch-ffmpeg.ps1
npm run tauri dev
```

If you already have `Dev\video-editor\tools\ffmpeg`, the repo can use a junction there.

## Timeline

Two horizontal bars: **video** and **audio** (waveform). Linked A/V until you click **Linked**. Overlay layer: paste onto existing clips (max one overlay per bar).

| Action | How |
|--------|-----|
| Trim | Drag either end of a clip |
| Move | Drag the clip (snaps to neighbors) |
| Zoom | Scroll wheel |
| Slice | `S`, Ctrl+X, or double-click the bar |
| Range select | Drag on empty track |
| Copy / paste | Ctrl+C / Ctrl+V (Shift+V paste as audio) |
| Unlink A/V | **Linked** button |

## Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+O | Open |
| Space | Play / pause |
| S / Ctrl+X | Slice at playhead |
| Delete | Delete selected clip (and linked pair) |
| Ctrl+C / V | Copy range / paste |
| Ctrl+Z / Y | Undo / redo |
| Ctrl+S | Save edited video |

Parked features and later work live in [BACKLOG.md](./BACKLOG.md).

## Agent / CLI

Edits are named commands (open, delete a time range, collapse blanks, export). The GUI is optional.

```powershell
npm run grimcut -- open D:\clip.mp4
npm run grimcut -- delete-range 0 60
npm run grimcut -- collapse-blank
npm run grimcut -- export D:\clip-cut.mp4
```

MCP stdio: `npm run mcp` (tools `grimcut_open`, `grimcut_delete_range`, `grimcut_collapse_blank`, `grimcut_frame`, `grimcut_export`, …). If Grimcut is already open, the CLI/MCP drive that instance through `%LOCALAPPDATA%\Grimcut\agent.json`, so the UI stays in sync. Otherwise they run the same core headless. Headless export handles a single remaining video clip (stream copy); multi-clip, overlay and burn-in need the app.

## License

MIT. FFmpeg binaries are GPL (see the fetch script / ffmpeg.org/legal.html).

# Grimcut

A simple Fluent-style video editor (ocenaudio vibe): drop a file, cut on a timeline, save.

Desktop app built with **Tauri 2 + React**, same family as [Grimpad](https://github.com/Grimstuff/grimpad). Local files only; FFmpeg does probe and export (stream copy on keyframe cuts, otherwise high-quality / GPU encode).

## Requirements

- Node 20+
- Rust (stable)
- Windows 10/11 + WebView2
- FFmpeg n8.1 shared (see setup)

## Setup

```powershell
cd C:\Users\Grimmers\Dev\grimcut
npm install
.\scripts\fetch-ffmpeg.ps1
npm run tauri dev
```

If you already have `Dev\video-editor\tools\ffmpeg`, the repo can use a junction there.

## Shortcuts

| Key | Action |
|-----|--------|
| Ctrl+O | Open |
| Space | Play / pause |
| Ctrl+X | Cut at playhead |
| Delete | Delete selected clip |
| Ctrl+Z / Y | Undo / redo |
| Ctrl+S | Save edited video |

## License

MIT. FFmpeg binaries are GPL (see the fetch script / ffmpeg.org/legal.html).

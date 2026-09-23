# Backlog

Parked work and later slices. Core clip editing (open, cut, preview, export) is in place.

## Next product slices

- **Poses (animation)** — not GOP keyframes. A pose is x/y/scale/rotation on a clip at a time; interpolate in preview; bake on export. Markers on the clip. Do not call GOP ticks “keyframes” in this UI.
- **Save project** — hamburger still a stub.
- **GIF export** — flyout item is a placeholder.
- **Record** — disabled chrome only.
- **Muxed subtitle tracks** — burn-in only for now.
- **Bitmap / closed-caption subs** (PGS, CEA-608) — out of scope unless we explicitly take them on.
- **More clip FX** — only Gaussian blur ships. Next that fit the same preview/bake shape: opacity + fade, then brightness/contrast/saturation, then chroma key. Speed, sharpen, vignette, flip, audio fades after that. Grain/glow/NTSC/stabilize later or export-only. CRT is not a fake preview overlay.

## Known leftovers (not blockers)

- Overlay GOP skip on trim-scrub can feel chunky.
- Grip cosmetics / WebView resize jitter — accepted.

## Agent control (shipped)

Named ops + JSON snapshot. **No mouse/screenshot loop.** A still frame (`grimcut_frame`) is an ffmpeg JPEG at a timeline time — optional visual, not how edits are made.

- **Headless CLI** (default): `npm run grimcut -- status|open|delete-range|collapse-blank|frame|export`
- **MCP**: `npm run mcp` — tools `grimcut_open`, `grimcut_delete_range`, `grimcut_collapse_blank`, `grimcut_frame`, `grimcut_export`, …
- If the Grimcut window is running, CLI/MCP talk to it (`%LOCALAPPDATA%/Grimcut/agent.json`) so the UI stays in sync. If not, they use the same core headless (session persisted next to that file).
- Headless export is **single remaining video clip** (stream copy). Multi-clip / overlay / burn-in needs the app.

## Later

- Timeline filmstrip: **luma envelope + async thumbs** (YouTube-style). Filmstrip stills for agents later if useful; cuts still use timestamps + `find-edit-points` skill.

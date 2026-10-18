# Backlog

Parked work and later slices. Core clip editing (open, cut, preview, export) is in place.

## Next product slices

- **Bake motion keys on export** — keys (pan/rotate/scale on a clip) edit and interpolate in preview, but export still uses the clip's static transform. Do not call GOP ticks “keyframes” in this UI.
- **Save project** — hamburger still a stub.
- **GIF export** — flyout item is a placeholder.
- **Record** — disabled chrome only.
- **Muxed subtitle tracks** — burn-in only for now.
- **Bitmap / closed-caption subs** (PGS, CEA-608) — out of scope unless we explicitly take them on.
- **More clip FX** — only Gaussian blur ships. Next that fit the same preview/bake shape: opacity + fade, then brightness/contrast/saturation, then chroma key. Speed, sharpen, vignette, flip, audio fades after that. Grain/glow/NTSC/stabilize later or export-only. CRT is not a fake preview overlay.

## Known leftovers (not blockers)

- Overlay GOP skip on trim-scrub can feel chunky.
- Grip cosmetics / WebView resize jitter — accepted.

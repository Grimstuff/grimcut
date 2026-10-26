# Changelog

## Unreleased

- Fixed: vertical phone videos opened as widescreen and looked stretched. Grimcut now reads the video's rotation flag, so the canvas, preview and export come out portrait.

## 0.2.2

- The FFmpeg download (installer, in-app prompt and dev script) always fetches the newest stable FFmpeg build instead of a pinned 8.1, so it keeps working when FFmpeg moves on. Tested with FFmpeg 9.0.

## 0.2.1

- Motion keys work the same on the overlay (2nd layer) as on the main track. The key button shows which layer it keys (1 or 2); click the little number to switch layers.
- New motion key bar: step between keys, toggle Move / Rotate / Scale per key, and pick Smooth or Hold. Keys are coloured by layer on the timeline.
- Easier to let go of a motion key: click it again, or click anywhere else on the timeline (Esc still works too).
- Fixed: an overlay could vanish after moving or resizing it (very visible with transparent webm overlays).
- Fixed: playing or scrubbing across an overlay no longer steals the selection from a clip you picked on the main track.


## 0.2.0

- New app icon in the Grim suite style.
- Check for updates in the hamburger menu. Installed copies download and install the new version, then reopen. The portable exe offers a download link instead. Grimcut never checks on its own.
- Motion keys on clips: pan, rotate and scale over time, with an optional hold-then-jump. Preview plays them; export doesn't bake them in yet.
- Export drops the source's chapter markers, so the seek bar no longer runs past the cut.

# Changelog

## 0.2.8

- Fully zoomed in, a cut (and dragging a clip edge) lands on the exact frame under the playhead instead of snapping to a nearby keyframe. At lower zoom cuts still snap to keyframes as before.

## 0.2.7

- Clicking or dragging the playhead on the timeline now lands on whole frames (using each clip's own frame rate), so fully zoomed in the seek handle steps frame by frame instead of gliding between frames.
- Fixed: exporting a cut that starts partway into a video sat at 0% for a long time (minutes on a long episode), because FFmpeg decoded everything before the cut first. It now jumps straight to the cut, so the export starts right away. Same picture, burned subtitles included.
- Fixed: an export could freeze for good if FFmpeg printed a lot of warnings.
- Fixed: exports could come out with no audio track at all while Grimcut reported a normal save (seen with long episodes cut far into the file). After every re-encode export Grimcut now checks that the file has audio when audio was expected, renders the audio on its own and adds it back if it is missing, and shows an error if it still cannot.
- The audio waveform now fills the track height. It is scaled to each source's own loud parts instead of absolute full scale, so normal-volume recordings no longer show as a thin band, and boosting a clip or region visibly grows it (about +2 dB reaches the edges). Waveforms are read at 16-bit, so quiet audio keeps its detail.

## 0.2.6

- The timeline no longer fights you over the horizontal scroll. During playback it keeps the playhead centred while following it, but as soon as you scroll, drag the scrollbar or pan, it stays where you put it. It picks the playhead up again when you press play, click to seek, or when playback reaches the middle of the view.
- Middle mouse drag pans the timeline from anywhere on it, including over clips, handles and the playhead.
- The move bar on main-track clips now sits at the bottom of the clip, so an overlay (2nd layer) above it no longer covers it. Overlay clips keep theirs at the top.

## 0.2.5

- Fixed: the "Generating thumbnails" status in the bottom bar flickered on and off while thumbnails loaded in batches. It now stays on steadily until all background work is done.

## 0.2.4

- Resizing a layer by a corner now stretches freely by default. Hold Shift to keep its aspect ratio (anchored to the opposite corner), or Alt to keep it from the center.

## 0.2.3

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

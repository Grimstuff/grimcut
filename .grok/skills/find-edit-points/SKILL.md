---
name: find-edit-points
description: >
  Find cut/in/out points in Grimcut cheaply before dumping video frames into vision.
  Use when trimming to a visual event (explosion, scene change, title card, impact),
  finding keyframes for in-points, or the user asks to cut to something they can see.
  Prefer ffmpeg stats over a folder of JPEGs. Slash command /find-edit-points.
---

# Find edit points (cheap first)

Do **not** extract a dense frame dump and vision-read dozens of stills. That is slow and expensive.

## Order of attack

1. **Keyframes (in-points)**  
   `ffprobe -skip_frame nokey -select_streams v:0 -show_entries frame=pts_time -of csv=p=0`  
   “First keyframe we run into” means the first **interior** GOP time **> 0**, not `0.000` even if it is a key.

2. **Flash / hit / hard cut (no vision)**  
   Luma spike or scene change:
   - `ffmpeg -i FILE -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -an -f null -`  
   - or `ffmpeg -i FILE -vf select='gt(scene,0.3)',showinfo -an -f null -`  
   Parse timestamps. An explosion/hit is usually the first big YAVG jump.

3. **JPEG size as a free hint**  
   If you already have sparse stills, a sudden size jump often marks a flash. Use it; don’t start there.

4. **Vision only to confirm**  
   At most **1 coarse strip** (e.g. 1 fps contact sheet **or** 3–8 frames around the candidate). Never a full-clip 4 fps dump unless the clip is a few seconds **and** stats failed.

5. **Apply the cut via Grimcut commands**, not the mouse:  
   `delete-range` / collapse-blank / export. Timeline filmstrip in the UI is for humans; agents should still prefer timestamps from (1)–(2).

## Output

Return **seconds** (source time): `in`, `out`, and how you got them (`keyframe list` / `luma spike at t=` / `confirmed frame`).

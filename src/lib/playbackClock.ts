/**
 * Preview: muted <video> (video-only mp4) + separate <audio> (AAC).
 * Playhead follows video.currentTime. On PIPELINE_ERROR_DECODE, reload and skip to the next keyframe.
 */
import { clipAt, clipSourcePath, timelineDuration } from "../core/project";
import type { Clip, VideoProject } from "../core/types";
import { clipEnd, clipGainAtSource } from "../core/types";
import { useEditor } from "../store/editorStore";
import { soundPrime, soundSet, soundStop, soundUnload } from "./previewSound";
import { hookMediaLog, playLog } from "./playLog";

const RAF_KEY = "__grimcutPlaybackRaf";
const GEN_KEY = "__grimcutPlaybackGen";
type ClockWin = Window & { [RAF_KEY]?: number; [GEN_KEY]?: number };

let videoEl: HTMLVideoElement | null = null;
let overlayEl: HTMLVideoElement | null = null;
let lastWall = 0;

function dbLin(db: number) {
  return Math.min(8, Math.max(0, 10 ** (db / 20)));
}

export function ensureAudioGraph() {
  return soundPrime();
}

export function setScrubPreview(t: number | null) {
  useEditor.setState({ scrubPreview: t });
  noteUserSeek();
  syncPreviewToPlayhead();
}

function keepEl(prev: HTMLVideoElement | null, next: HTMLVideoElement | null) {
  if (next) return next;
  if (prev?.isConnected) return prev;
  return null;
}

/** How far past a clip's source end the playing picture may run and still count as that clip.
 *  Covers a late frame tick; the playhead is then held at the clip's end. */
const RUN_ON = 0.5;

/**
 * Timeline time of the playing main picture, read only against the clip under the playhead.
 * The element plays its file straight on, so at the end of a clip it runs into source the next
 * clip may not use (a pasted or moved piece). Looking that time up anywhere on the timeline
 * jumped the playhead to wherever that source sits, e.g. back to where a paste came from.
 * Held at the clip's end instead, the playhead moves on to the next clip and the picture is
 * seeked there. Null when the picture isn't showing this clip yet (loading or seeking).
 */
export function timelineOnClip(p: VideoProject, srcT: number, playhead: number, path?: string): number | null {
  const cur = clipAt(p, playhead, "video", "base");
  if (!cur) return null;
  if (path && clipSourcePath(p, cur) !== path) return null;
  if (srcT < cur.sourceStart - 0.05 || srcT > cur.sourceEnd + RUN_ON) return null;
  const tl = Math.min(clipEnd(cur), cur.timelineStart + Math.max(0, srcT - cur.sourceStart));
  // Playback only moves the playhead a little at a time. Anything further is the picture still
  // showing the last clip's source (its seek to this clip hasn't landed yet).
  if (tl < playhead - 0.25 || tl > playhead + 0.75) return null;
  return tl;
}

function videoTimeline(p: VideoProject, v: HTMLVideoElement, srcT: number) {
  return timelineOnClip(p, srcT, useEditor.getState().playhead, v.dataset.mediaPath || undefined);
}

function pullPlayheadFromVideo() {
  const st = useEditor.getState();
  const p = st.project;
  const v = videoEl;
  // Only playback moves the playhead from the picture. A paused seek (scrub, click,
  // frame step) fires timeupdate too, and must not overwrite where the user put it.
  if (!st.playing || st.scrubPreview != null) return;
  if (!p || !v || !Number.isFinite(v.currentTime) || v.dataset.recovering === "1") return;
  const ph = videoTimeline(p, v, v.currentTime);
  if (ph == null) return;
  useEditor.setState({ playhead: ph, exactPlayhead: false, showBlack: false, previewOver: !!clipAt(p, ph, "video", "over") });
  driveSound(p, ph, !v.paused && !v.error, st.previewVolume);
}

function nextKeyframeAfter(t: number) {
  const kfs = useEditor.getState().media?.keyframeTimes ?? [];
  for (const k of kfs) {
    if (k > t + 0.12) return k;
  }
  return t + 0.5;
}

/** WebView kills the whole decoder on a bad NAL. Reload the tag and jump to the next key. */
function skipBrokenFrame(el: HTMLVideoElement): boolean {
  if (el.dataset.recovering === "1") return true;
  const now = performance.now();
  const last = Number(el.dataset.lastSkip || 0);
  let n = Number(el.dataset.skipN || 0);
  if (now - last > 8000) n = 0;
  if (now - last < 700) return n < 8;
  n += 1;
  el.dataset.skipN = String(n);
  el.dataset.lastSkip = String(now);
  if (n > 8) return false;
  const from = Number.isFinite(el.currentTime) ? el.currentTime : 0;
  const to = nextKeyframeAfter(from);
  const src = el.getAttribute("src") || el.src;
  if (!src) return false;
  playLog(`skip ${from.toFixed(2)} -> ${to.toFixed(2)} (#${n})`);
  el.dataset.recovering = "1";
  const p = useEditor.getState().project;
  if (p) {
    const ph = videoTimeline(p, el, to);
    if (ph != null) useEditor.setState({ playhead: ph, exactPlayhead: false, status: `Skipped bad frame @ ${from.toFixed(1)}s` });
  }
  el.pause();
  el.removeAttribute("src");
  try {
    el.load();
  } catch {
    /* ignore */
  }
  el.src = src;
  let done = false;
  const resume = () => {
    if (done) return;
    done = true;
    el.dataset.recovering = "";
    el.dataset.lastSeek = String(performance.now());
    el.dataset.userSeek = "1";
    try {
      el.currentTime = to;
    } catch {
      /* ignore */
    }
    const go = () => {
      if (useEditor.getState().playing) playMedia(el, false);
    };
    el.addEventListener("seeked", go, { once: true });
    window.setTimeout(go, 350);
  };
  el.addEventListener("loadeddata", resume, { once: true });
  window.setTimeout(resume, 700);
  return true;
}

export function setPreviewVideo(el: HTMLVideoElement | null) {
  videoEl = keepEl(videoEl, el);
  if (!videoEl || videoEl.dataset.timeHook === "1") return;
  videoEl.dataset.timeHook = "1";
  hookMediaLog(videoEl, "vid");
  videoEl.addEventListener("timeupdate", pullPlayheadFromVideo);
  videoEl.addEventListener("error", () => {
    if (!videoEl) return;
    if (!skipBrokenFrame(videoEl)) {
      useEditor.setState({ playing: false, status: "Preview decode failed (too many bad frames)." });
      pauseAll();
    }
  });
}

export function setOverlayVideo(el: HTMLVideoElement | null) {
  overlayEl = keepEl(overlayEl, el);
  if (overlayEl) hookMediaLog(overlayEl, "over");
}

function pauseAll() {
  videoEl?.pause();
  overlayEl?.pause();
  soundStop();
}

function dropVideo(el: HTMLVideoElement | null) {
  if (!el) return;
  el.pause();
  el.removeAttribute("src");
  try {
    el.load();
  } catch {
    /* ignore */
  }
}

export function haltPlayback() {
  lastWall = 0;
  dropVideo(videoEl);
  dropVideo(overlayEl);
  soundUnload();
}

function clipGainDb(clip: Clip | null, ph: number): number {
  if (!clip) return 0;
  const src = clip.sourceStart + (ph - clip.timelineStart);
  let db = clipGainAtSource(clip, src);
  const st = useEditor.getState();
  if (st.selLane === "audio" && Math.abs(st.gainDraft) > 0.01) {
    const hit = st.clipSel.some((s) => s.clipId === clip.id && ph >= s.start && ph < s.end);
    if (hit) db += st.gainDraft;
  }
  return db;
}

function urlFor(p: VideoProject, clip: Clip) {
  const path = clipSourcePath(p, clip);
  const st = useEditor.getState();
  if (clip.kind === "audio") {
    return st.audioPreviewByPath[path] ?? st.previewByPath[path] ?? (path === p.sourcePath ? st.previewUrl : null);
  }
  return st.previewByPath[path] ?? (path === p.sourcePath ? st.previewUrl : null);
}

/** Audio clip each sound channel played last, to spot a move onto another clip, and whether
 *  the sound still has to be put on that clip's spot. */
const soundClip: Record<"base" | "over", string | null> = { base: null, over: null };
const soundPending: Record<"base" | "over", boolean> = { base: false, over: false };

function driveSound(p: VideoProject, ph: number, playing: boolean, vol: number) {
  const drive = (which: "base" | "over", clip: Clip | null) => {
    if (clip && soundClip[which] !== clip.id) soundPending[which] = true;
    soundClip[which] = clip?.id ?? null;
    if (!clip) {
      soundSet(which, null, null, 0, false, 0);
      return;
    }
    const url = urlFor(p, clip);
    const path = clipSourcePath(p, clip);
    const t = Math.max(0, clip.sourceStart + (ph - clip.timelineStart));
    if (soundSet(which, url ? path : null, url, t, playing, vol * dbLin(clipGainDb(clip, ph)), soundPending[which])) {
      soundPending[which] = false;
    }
  };
  drive("base", clipAt(p, ph, "audio", "base"));
  drive("over", clipAt(p, ph, "audio", "over"));
}

export function applyPreviewVolume(v: number) {
  const vol = Math.max(0, Math.min(1, v));
  const st = useEditor.getState();
  if (!st.project) return;
  const ph = st.scrubPreview ?? st.playhead;
  driveSound(st.project, ph, st.playing && st.scrubPreview == null, vol);
}

function playMedia(v: HTMLMediaElement, fromUser: boolean) {
  if (!v.paused || v.dataset.playLock === "1" || v.error || v.dataset.recovering === "1") return;
  if (v.seeking) return;
  if (v.readyState < 2) {
    if (v.dataset.waitPlay === "1") return;
    v.dataset.waitPlay = "1";
    v.addEventListener(
      "canplay",
      () => {
        v.dataset.waitPlay = "";
        if (useEditor.getState().playing && v.paused) playMedia(v, fromUser);
      },
      { once: true },
    );
    return;
  }
  v.dataset.playLock = "1";
  void v
    .play()
    .catch((err: unknown) => {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "AbortError") return;
      if (fromUser) {
        useEditor.setState({
          status: `Preview play failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })
    .finally(() => {
      v.dataset.playLock = "";
    });
}

function assignSrc(el: HTMLMediaElement, path: string, url: string) {
  if (el.dataset.mediaPath === path && el.getAttribute("src")) return;
  el.dataset.mediaPath = path;
  delete el.dataset.pausedTarget;
  el.src = url;
  // A fresh load sits on frame 0; its first seek must not be throttled by the previous one.
  el.dataset.lastSeek = "0";
}

/** Mismatch at which a playing picture is seeked: a clip change, not playback jitter. */
const PLAY_JUMP = 0.25;
/** Largest picture/playhead mismatch a paused preview tolerates: well under a frame at 240 fps. */
const PAUSED_DRIFT = 0.003;
/** A paused seek lands 1 ms inside the frame that starts at the playhead, so float rounding
 *  of a frame-start time cannot make the decoder show the previous frame. */
const FRAME_NUDGE = 0.001;
/** How long the paused playhead has to stay put before the picture is seeked to its exact frame. */
const SETTLE_MS = 120;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function seekTo(el: HTMLMediaElement, target: number, paused: boolean) {
  const now = performance.now();
  el.dataset.lastSeek = String(now);
  el.dataset.lastSeekAt = String(now);
  el.dataset.userSeek = "";
  if (paused) el.dataset.pausedTarget = String(target);
  else delete el.dataset.pausedTarget;
  try {
    el.currentTime = target;
  } catch {
    /* ignore */
  }
}

function settleLater(wait: number) {
  if (settleTimer) return;
  settleTimer = setTimeout(() => {
    settleTimer = null;
    syncPreviewToPlayhead();
  }, Math.max(10, wait));
}

function seekIfNeeded(el: HTMLMediaElement, srcTime: number, playing: boolean) {
  if (el.dataset.playLock === "1" || el.dataset.recovering === "1") return;
  if (el.error) {
    if (el instanceof HTMLVideoElement) skipBrokenFrame(el);
    return;
  }
  if (el.seeking) return;
  const user = el.dataset.userSeek === "1";
  const precise = useEditor.getState().scrubPreview != null;
  const last = Number(el.dataset.lastSeek || 0);
  if (playing) {
    delete el.dataset.pausedTarget;
    const drift = Number.isFinite(el.currentTime) ? Math.abs(el.currentTime - srcTime) : 99;
    // Playing on its own is left alone, unless the picture is clearly on the wrong spot: a new
    // clip whose source doesn't follow on from the last one (a pasted or moved piece).
    if (!el.paused && el.readyState >= 2 && !user && !precise && drift < PLAY_JUMP) return;
    const need = user ? 0.04 : 0.05;
    if (drift > need && performance.now() - last > 80) seekTo(el, srcTime, false);
    return;
  }
  // Paused, the picture has to end up on the playhead's own frame: it is what the user cuts by
  // (a 0.04s dead zone is 2.4 frames at 60 fps, which put cuts placed by eye 2-3 frames off).
  // But every exact seek decodes from the previous keyframe, hundreds of frames on a long-GOP
  // source, so while the playhead is moving (drag, trim, key repeat) the picture only follows
  // within a few frames as before, and lands on the exact frame once the playhead settles.
  let target = srcTime + FRAME_NUDGE;
  if (Number.isFinite(el.duration) && el.duration > 0) target = Math.min(target, el.duration);
  const drift = Number.isFinite(el.currentTime) ? Math.abs(el.currentTime - target) : 99;
  if (drift <= PAUSED_DRIFT) return;
  // Already seeked to this exact spot. The element can report a slightly different time
  // afterwards; seeking it again would loop forever.
  const asked = Number(el.dataset.pausedTarget);
  if (Number.isFinite(asked) && Math.abs(asked - target) < 1e-4) return;
  const since = performance.now() - Number(el.dataset.lastSeekAt || 0);
  if (since >= SETTLE_MS) {
    seekTo(el, target, true);
    return;
  }
  if (drift > 0.04 && performance.now() - last > (precise ? 20 : 80)) {
    seekTo(el, target, true);
    return;
  }
  settleLater(SETTLE_MS - since);
}

function syncPicture(el: HTMLVideoElement | null, p: VideoProject, clip: Clip | null, ph: number, playing: boolean) {
  if (!el) return;
  el.muted = true;
  el.volume = 0;
  if (!clip) {
    if (!el.paused) el.pause();
    return;
  }
  const url = urlFor(p, clip);
  if (url) assignSrc(el, clipSourcePath(p, clip), url);
  seekIfNeeded(el, Math.max(0, clip.sourceStart + (ph - clip.timelineStart)), playing);
  if (playing) {
    if (!el.error && el.paused && !el.seeking) playMedia(el, false);
  } else if (!el.paused) {
    el.pause();
  }
}

export function syncPreviewToPlayhead() {
  const st = useEditor.getState();
  if (!st.project) return;
  const p = st.project;
  const ph = st.scrubPreview ?? st.playhead;
  const playing = st.playing && st.scrubPreview == null;
  syncPicture(videoEl, p, clipAt(p, ph, "video", "base"), ph, playing);
  syncPicture(overlayEl, p, clipAt(p, ph, "video", "over"), ph, playing);
  driveSound(p, ph, playing, st.previewVolume);
}

function rewindToStart() {
  lastWall = 0;
  pauseAll();
  useEditor.getState().setPlayhead(0);
  useEditor.setState({ playing: false, previewOver: false });
  syncPreviewToPlayhead();
}

export function noteUserSeek() {
  for (const el of [videoEl, overlayEl]) {
    if (!el) continue;
    el.dataset.lastSeek = "0";
    el.dataset.userSeek = "1";
  }
}

export function markVideoSeekDone() {
  if (!useEditor.getState().playing) {
    // A frame step that came in while the last seek was running was skipped; catch up now.
    syncPreviewToPlayhead();
    return;
  }
  if (videoEl?.paused) playMedia(videoEl, false);
  if (overlayEl?.paused) playMedia(overlayEl, false);
}

export function togglePlayback() {
  const st = useEditor.getState();
  if (st.menuOpen) {
    st.setMenuOpen(false);
    return;
  }
  if (!st.project) return;
  if (st.playing) {
    st.setPlaying(false);
    lastWall = 0;
    pauseAll();
    // Settle the paused picture on the playhead's frame, which is where a cut would go.
    syncPreviewToPlayhead();
    return;
  }
  lastWall = 0;
  st.setPlaying(true);
  const kick = () => {
    syncPreviewToPlayhead();
    const p = useEditor.getState().project;
    if (!p) return;
    const ph = useEditor.getState().playhead;
    if (clipAt(p, ph, "video", "base") && videoEl) playMedia(videoEl, true);
    if (clipAt(p, ph, "video", "over") && overlayEl) playMedia(overlayEl, true);
  };
  void soundPrime().then(kick);
}

function tick(now: number) {
  const st = useEditor.getState();
  if (!st.playing) {
    lastWall = 0;
    return;
  }
  const p = st.project;
  if (!p) {
    st.setPlaying(false);
    lastWall = 0;
    return;
  }
  const dt = lastWall ? Math.min(0.08, (now - lastWall) / 1000) : 0;
  lastWall = now;
  const end = Math.max(timelineDuration(p), 0.01);
  let ph = st.playhead;

  if (videoEl?.error) {
    if (!skipBrokenFrame(videoEl)) {
      lastWall = 0;
      pauseAll();
      useEditor.setState({ playing: false, status: "Preview decode failed (too many bad frames)." });
    }
    return;
  }

  const fromVid = videoEl && Number.isFinite(videoEl.currentTime) ? videoTimeline(p, videoEl, videoEl.currentTime) : null;
  if (fromVid != null) {
    ph = fromVid;
    if (videoEl!.paused && !videoEl!.seeking) playMedia(videoEl!, false);
  } else {
    ph += dt;
  }
  ph = Math.min(end, Math.max(0, ph));
  if (ph >= end - 0.0005) {
    rewindToStart();
    return;
  }
  useEditor.setState({ playhead: ph, exactPlayhead: false, showBlack: false, previewOver: !!clipAt(p, ph, "video", "over") });
  syncPreviewToPlayhead();
}

export function startPlaybackClock() {
  const w = window as ClockWin;
  if (w[RAF_KEY]) cancelAnimationFrame(w[RAF_KEY]!);
  const my = (w[GEN_KEY] ?? 0) + 1;
  w[GEN_KEY] = my;
  const loop = (now: number) => {
    if (w[GEN_KEY] !== my) return;
    w[RAF_KEY] = requestAnimationFrame(loop);
    tick(now);
  };
  w[RAF_KEY] = requestAnimationFrame(loop);
  return () => {
    w[GEN_KEY] = (w[GEN_KEY] ?? 0) + 1;
    if (w[RAF_KEY]) cancelAnimationFrame(w[RAF_KEY]!);
    w[RAF_KEY] = undefined;
  };
}

/** The live <video> for a canvas layer (preview only). */
export function layerVideo(layer: "base" | "over"): HTMLVideoElement | null {
  return layer === "over" ? overlayEl : videoEl;
}

/**
 * Preview: muted <video> (video-only mp4) + separate <audio> (AAC).
 * Playhead follows video.currentTime. On PIPELINE_ERROR_DECODE, reload and skip to the next keyframe.
 */
import { clipAt, clipSourcePath, timelineDuration } from "../core/project";
import type { Clip, VideoProject } from "../core/types";
import { clipGainAtSource } from "../core/types";
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

function timelineFromVideoTime(p: VideoProject, srcT: number) {
  for (const c of p.clips) {
    if (c.kind !== "video" || c.layer === "over") continue;
    if (srcT >= c.sourceStart - 0.05 && srcT <= c.sourceEnd + 0.05) {
      return c.timelineStart + (srcT - c.sourceStart);
    }
  }
  return null;
}

function pullPlayheadFromVideo() {
  const st = useEditor.getState();
  const p = st.project;
  const v = videoEl;
  if (!p || !v || !Number.isFinite(v.currentTime) || v.dataset.recovering === "1") return;
  const ph = timelineFromVideoTime(p, v.currentTime);
  if (ph == null) return;
  useEditor.setState({ playhead: ph, showBlack: false, previewOver: !!clipAt(p, ph, "video", "over") });
  if (st.playing) driveSound(p, ph, !v.paused && !v.error, st.previewVolume);
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
    const ph = timelineFromVideoTime(p, to);
    if (ph != null) useEditor.setState({ playhead: ph, status: `Skipped bad frame @ ${from.toFixed(1)}s` });
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

function driveSound(p: VideoProject, ph: number, playing: boolean, vol: number) {
  const drive = (which: "base" | "over", clip: Clip | null) => {
    if (!clip) {
      soundSet(which, null, null, 0, false, 0);
      return;
    }
    const url = urlFor(p, clip);
    const path = clipSourcePath(p, clip);
    const t = Math.max(0, clip.sourceStart + (ph - clip.timelineStart));
    soundSet(which, url ? path : null, url, t, playing, vol * dbLin(clipGainDb(clip, ph)));
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
  el.src = url;
  // A fresh load sits on frame 0; its first seek must not be throttled by the previous one.
  el.dataset.lastSeek = "0";
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
  if (playing && !el.paused && el.readyState >= 2 && !user && !precise) return;
  const drift = Number.isFinite(el.currentTime) ? Math.abs(el.currentTime - srcTime) : 99;
  const need = precise || user ? 0.04 : 0.05;
  const last = Number(el.dataset.lastSeek || 0);
  if (drift > need && performance.now() - last > (precise ? 20 : 80)) {
    el.dataset.lastSeek = String(performance.now());
    el.dataset.userSeek = "";
    try {
      el.currentTime = srcTime;
    } catch {
      /* ignore */
    }
  }
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
  if (!useEditor.getState().playing) return;
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

  const fromVid = videoEl && Number.isFinite(videoEl.currentTime) ? timelineFromVideoTime(p, videoEl.currentTime) : null;
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
  useEditor.setState({ playhead: ph, showBlack: false, previewOver: !!clipAt(p, ph, "video", "over") });
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

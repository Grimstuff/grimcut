import { clipAt, clipSourcePath, timelineDuration } from "../core/project";
import type { Clip, VideoProject } from "../core/types";
import { useEditor } from "../store/editorStore";

const RAF_KEY = "__grimcutPlaybackRaf";
const GEN_KEY = "__grimcutPlaybackGen";

type ClockWin = Window & { [RAF_KEY]?: number; [GEN_KEY]?: number };

let videoEl: HTMLVideoElement | null = null;
let overlayEl: HTMLVideoElement | null = null;
let lastWall = 0;
let lastSeekAt = 0;

export function setPreviewVideo(el: HTMLVideoElement | null) {
  videoEl = el;
}

export function setOverlayVideo(el: HTMLVideoElement | null) {
  overlayEl = el;
}

function pauseAll() {
  videoEl?.pause();
  overlayEl?.pause();
}

export function applyPreviewVolume(v: number) {
  const vol = Math.max(0, Math.min(1, v));
  if (videoEl) {
    videoEl.volume = vol;
    videoEl.muted = vol <= 0;
  }
  if (overlayEl) {
    overlayEl.volume = vol;
    overlayEl.muted = vol <= 0;
  }
}

function playVideo(v: HTMLVideoElement, fromUser: boolean) {
  const p = v.play();
  if (p && typeof p.catch === "function") {
    void p.catch((err: unknown) => {
      if (!fromUser) return;
      useEditor.setState({
        playing: false,
        status: `Preview play failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    });
  }
}

function urlFor(p: VideoProject, clip: Clip) {
  const path = clipSourcePath(p, clip);
  const st = useEditor.getState();
  return st.previewByPath[path] ?? (path === p.sourcePath ? st.previewUrl : null);
}

function assignSrc(el: HTMLVideoElement, path: string, url: string) {
  if (el.dataset.mediaPath === path && el.getAttribute("src")) return;
  el.dataset.mediaPath = path;
  el.src = url;
}

function syncLayer(el: HTMLVideoElement | null, p: VideoProject, clip: Clip | null, ph: number, playing: boolean) {
  if (!el) return;
  if (!clip) {
    if (!el.paused) el.pause();
    return;
  }
  const url = urlFor(p, clip);
  if (url) assignSrc(el, clipSourcePath(p, clip), url);
  const srcTime = Math.max(0, clip.sourceStart + (ph - clip.timelineStart));
  const drift = Number.isFinite(el.currentTime) ? Math.abs(el.currentTime - srcTime) : 99;
  const need = playing ? 0.35 : 0.05;
  if (drift > need && !el.seeking && performance.now() - lastSeekAt > 80) {
    lastSeekAt = performance.now();
    try {
      el.currentTime = srcTime;
    } catch {
      /* ignore */
    }
  }
  const vol = useEditor.getState().previewVolume;
  el.volume = vol;
  el.muted = vol <= 0;
  if (playing && el.paused) playVideo(el, false);
  if (!playing && !el.paused) el.pause();
}

export function syncPreviewToPlayhead() {
  const st = useEditor.getState();
  if (!st.project) return;
  const p = st.project;
  const ph = st.playhead;
  syncLayer(videoEl, p, clipAt(p, ph, "video", "base"), ph, st.playing);
  syncLayer(overlayEl, p, clipAt(p, ph, "video", "over"), ph, st.playing);
}

function rewindToStart() {
  lastWall = 0;
  pauseAll();
  useEditor.getState().setPlayhead(0);
  useEditor.setState({ playing: false, previewOver: false });
  syncPreviewToPlayhead();
}

export function noteUserSeek() {
  lastSeekAt = 0;
}

export function markVideoSeekDone() {
  const st = useEditor.getState();
  if (!st.playing) return;
  if (videoEl?.paused) playVideo(videoEl, false);
  if (overlayEl?.paused) playVideo(overlayEl, false);
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
  syncPreviewToPlayhead();
  const p = st.project;
  const ph = st.playhead;
  if (clipAt(p, ph, "video", "base") && videoEl) playVideo(videoEl, true);
  if (clipAt(p, ph, "video", "over") && overlayEl) playVideo(overlayEl, true);
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
  const ph = Math.min(end, st.playhead + dt);
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

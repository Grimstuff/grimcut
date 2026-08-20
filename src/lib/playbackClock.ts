import { mapTimelineToSource, timelineDuration } from "../core/project";
import { clipEnd, type Clip } from "../core/types";
import { useEditor } from "../store/editorStore";

const RAF_KEY = "__grimcutPlaybackRaf";
const GEN_KEY = "__grimcutPlaybackGen";

type ClockWin = Window & { [RAF_KEY]?: number; [GEN_KEY]?: number };

let videoEl: HTMLVideoElement | null = null;
let lastWall = 0;
let lastClipId: string | null = null;
let fileSeeking = false;
let seekTarget: number | null = null;
/** Hide the picture while the decoder rewinds to a previous keyframe (overlay → base). */
let covering = false;

export function setPreviewVideo(el: HTMLVideoElement | null) {
  videoEl = el;
}

export function markVideoSeekDone() {
  const v = videoEl;
  const st = useEditor.getState();
  if (st.playing && v && v.paused) playVideo(v, false);
}

function sourceInClip(src: number, clip: Clip) {
  return src >= clip.sourceStart - 0.05 && src < clip.sourceEnd - 0.03;
}

function seekTo(v: HTMLVideoElement, source: number) {
  const t = Math.max(0, source);
  const from = v.currentTime;
  seekTarget = t;
  fileSeeking = true;
  covering = Number.isFinite(from) && from - t > 0.08;
  if (!v.paused) v.pause();
  if (!Number.isFinite(from) || Math.abs(from - t) > 0.04) {
    try {
      v.currentTime = t;
    } catch {
      fileSeeking = false;
      covering = false;
      seekTarget = null;
    }
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

/** Space and click both hit this. Must call video.play() on the same user-gesture stack. */
export function togglePlayback() {
  const st = useEditor.getState();
  if (st.menuOpen) {
    st.setMenuOpen(false);
    return;
  }
  if (!st.project) return;

  const v = videoEl;
  if (st.playing) {
    st.setPlaying(false);
    lastWall = 0;
    covering = false;
    fileSeeking = false;
    v?.pause();
    return;
  }

  lastWall = 0;
  covering = false;
  fileSeeking = false;
  seekTarget = null;
  st.setPlaying(true);

  const mapped = mapTimelineToSource(st.project, st.playhead);
  if (!mapped) {
    lastClipId = null;
    v?.pause();
    return;
  }
  lastClipId = mapped.clip.id;
  if (!v) return;
  seekTo(v, mapped.source);
  covering = false;
  playVideo(v, true);
}

function tick(now: number) {
  const st = useEditor.getState();
  const v = videoEl;

  if (!st.playing) {
    lastWall = 0;
    covering = false;
    if (v && !v.paused) v.pause();
    return;
  }

  const p = st.project;
  if (!p) {
    st.setPlaying(false);
    lastWall = 0;
    return;
  }

  const end = Math.max(timelineDuration(p), 0.01);
  let ph = st.playhead;
  let mapped = mapTimelineToSource(p, ph);

  if (v && mapped && (fileSeeking || covering || v.seeking)) {
    const src = v.currentTime;
    const target = seekTarget ?? mapped.source;
    const behind = Number.isFinite(src) && src < target - 0.05;
    if (behind || v.seeking) {
      if (behind && v.paused) playVideo(v, false);
      lastWall = now;
      useEditor.setState({
        playhead: ph,
        showBlack: covering || v.seeking,
        selectedId: mapped.clip.id,
      });
      return;
    }
    fileSeeking = false;
    covering = false;
    seekTarget = null;
  }

  if (mapped && v && lastClipId === mapped.clip.id && !fileSeeking && !v.paused && !v.seeking) {
    const src = v.currentTime;
    if (sourceInClip(src, mapped.clip)) {
      const local = mapped.clip.timelineStart + (src - mapped.clip.sourceStart);
      if (local + 0.04 < ph) {
        lastWall = now;
        if (v.paused) playVideo(v, false);
        useEditor.setState({ playhead: ph, showBlack: true, selectedId: mapped.clip.id });
        return;
      }
      lastWall = now;
      ph = Math.max(mapped.clip.timelineStart, Math.min(clipEnd(mapped.clip) - 0.0005, local));
      useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
      return;
    }
    if (!v.paused) v.pause();
    ph = clipEnd(mapped.clip);
    lastClipId = null;
  } else if (!mapped) {
    const dt = lastWall ? Math.min(0.08, (now - lastWall) / 1000) : 0;
    lastWall = now;
    ph = Math.min(end, ph + dt);
  } else {
    lastWall = now;
  }

  if (ph >= end - 0.0005) {
    useEditor.setState({ playhead: end, showBlack: true, playing: false });
    lastWall = 0;
    covering = false;
    v?.pause();
    return;
  }

  mapped = mapTimelineToSource(p, ph);
  if (!mapped) {
    lastClipId = null;
    covering = false;
    fileSeeking = false;
    useEditor.setState({ playhead: ph, showBlack: true });
    if (v && !v.paused) v.pause();
    return;
  }

  useEditor.setState({ playhead: ph, showBlack: covering, selectedId: mapped.clip.id });
  if (!v) return;

  if (lastClipId !== mapped.clip.id) {
    lastClipId = mapped.clip.id;
    seekTo(v, mapped.source);
    return;
  }
  if (v.paused && !fileSeeking && !v.seeking) playVideo(v, false);
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

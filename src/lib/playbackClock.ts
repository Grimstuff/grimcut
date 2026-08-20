import { mapTimelineToSource, timelineDuration } from "../core/project";
import { clipEnd } from "../core/types";
import { useEditor } from "../store/editorStore";

const RAF_KEY = "__grimcutPlaybackRaf";
const GEN_KEY = "__grimcutPlaybackGen";

type ClockWin = Window & { [RAF_KEY]?: number; [GEN_KEY]?: number };

let videoEl: HTMLVideoElement | null = null;
let lastWall = 0;
let lastClipId: string | null = null;
let fileSeeking = false;

export function setPreviewVideo(el: HTMLVideoElement | null) {
  videoEl = el;
}

export function markVideoSeekDone() {
  fileSeeking = false;
}

function seekIfNeeded(v: HTMLVideoElement, source: number) {
  if (!Number.isFinite(v.currentTime) || Math.abs(v.currentTime - source) > 0.05) {
    fileSeeking = true;
    try {
      v.currentTime = Math.max(0, source);
    } catch {
      fileSeeking = false;
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
    v?.pause();
    return;
  }

  lastWall = 0;
  fileSeeking = false;
  st.setPlaying(true);

  const mapped = mapTimelineToSource(st.project, st.playhead);
  if (!mapped) {
    lastClipId = null;
    v?.pause();
    return;
  }
  lastClipId = mapped.clip.id;
  if (!v) return;
  seekIfNeeded(v, mapped.source);
  playVideo(v, true);
}

function tick(now: number) {
  const st = useEditor.getState();
  const v = videoEl;

  if (!st.playing) {
    lastWall = 0;
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

  if (mapped && v && lastClipId === mapped.clip.id && !fileSeeking && !v.paused) {
    const src = v.currentTime;
    const inClip = src >= mapped.clip.sourceStart - 0.08 && src < mapped.clip.sourceEnd - 0.02;
    if (inClip) {
      lastWall = now;
      const local = mapped.clip.timelineStart + (src - mapped.clip.sourceStart);
      ph = Math.max(mapped.clip.timelineStart, Math.min(clipEnd(mapped.clip) - 0.0005, local));
      useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
      return;
    }
    // File ran off the end of this timeline clip — jump to the next timeline beat, not the next source frame.
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
    v?.pause();
    return;
  }

  mapped = mapTimelineToSource(p, ph);
  if (!mapped) {
    lastClipId = null;
    useEditor.setState({ playhead: ph, showBlack: true });
    if (v && !v.paused) v.pause();
    return;
  }

  useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
  if (!v) return;

  if (lastClipId !== mapped.clip.id) {
    lastClipId = mapped.clip.id;
    seekIfNeeded(v, mapped.source);
    playVideo(v, false);
    return;
  }
  if (v.paused && !fileSeeking) playVideo(v, false);
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

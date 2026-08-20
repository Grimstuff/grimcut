import { mapTimelineToSource, timelineDuration } from "../core/project";
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
  lastClipId = null;
  fileSeeking = false;
}

export function markVideoSeekDone() {
  fileSeeking = false;
}

export function resetPlaybackClock() {
  lastWall = 0;
  lastClipId = null;
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

  const dt = lastWall ? Math.min(0.08, (now - lastWall) / 1000) : 0;
  lastWall = now;
  const end = Math.max(timelineDuration(p), 0.01);
  const ph = Math.min(end, st.playhead + dt);

  if (ph >= end - 0.0005) {
    useEditor.setState({ playhead: end, showBlack: true, playing: false });
    lastWall = 0;
    if (v && !v.paused) v.pause();
    return;
  }

  const mapped = mapTimelineToSource(p, ph);
  if (!mapped) {
    lastClipId = null;
    useEditor.setState({ playhead: ph, showBlack: true });
    if (v && !v.paused) v.pause();
    return;
  }

  useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
  if (!v) return;

  const changed = lastClipId !== mapped.clip.id;
  lastClipId = mapped.clip.id;
  if (changed) {
    fileSeeking = true;
    try {
      v.currentTime = Math.max(0, mapped.source);
    } catch {
      /* ignore */
    }
    void v.play().catch(() => {});
    return;
  }
  if (!fileSeeking && Math.abs(v.currentTime - mapped.source) > 0.4) {
    fileSeeking = true;
    try {
      v.currentTime = Math.max(0, mapped.source);
    } catch {
      /* ignore */
    }
  }
  if (v.paused && !fileSeeking) void v.play().catch(() => {});
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

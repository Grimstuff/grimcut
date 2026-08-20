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
let covering = false;
/** Playhead may not go below this while playing — stops overlay/base ping-pong. */
let minPh = 0;
let lastSeekAt = 0;
let destClipId: string | null = null;

export function setPreviewVideo(el: HTMLVideoElement | null) {
  videoEl = el;
}

export function noteUserSeek() {
  lastClipId = null;
  covering = false;
  fileSeeking = false;
  seekTarget = null;
  minPh = 0;
  destClipId = null;
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

function inDest(src: number, clip: Clip, target: number) {
  return src >= target - 0.05 && src < clip.sourceEnd - 0.02;
}

function seekTo(v: HTMLVideoElement, source: number, clipId: string) {
  const now = performance.now();
  if (destClipId === clipId && now - lastSeekAt < 100) return;
  lastSeekAt = now;
  destClipId = clipId;
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

export function markVideoSeekDone() {
  const v = videoEl;
  const st = useEditor.getState();
  if (!v || !st.playing) return;
  const target = seekTarget;
  if (target == null) {
    if (v.paused) playVideo(v, false);
    return;
  }
  const src = v.currentTime;
  if (src > target + 0.12) {
    if (performance.now() - lastSeekAt > 100) {
      lastSeekAt = 0;
      destClipId = null;
      try {
        v.currentTime = target;
      } catch {
        /* ignore */
      }
    }
    return;
  }
  if (src < target - 0.05) {
    playVideo(v, false);
    return;
  }
  covering = false;
  fileSeeking = false;
  if (v.paused) playVideo(v, false);
}

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
  destClipId = null;
  minPh = st.playhead;
  st.setPlaying(true);

  const mapped = mapTimelineToSource(st.project, st.playhead);
  if (!mapped) {
    lastClipId = null;
    v?.pause();
    return;
  }
  lastClipId = mapped.clip.id;
  if (!v) return;
  seekTo(v, mapped.source, mapped.clip.id);
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
  let ph = Math.max(st.playhead, minPh);
  let mapped = mapTimelineToSource(p, ph);

  if (v && mapped && (fileSeeking || covering)) {
    const src = v.currentTime;
    const target = seekTarget ?? mapped.source;
    const dest = Number.isFinite(src) && inDest(src, mapped.clip, target);
    if (!dest || v.seeking) {
      const ahead = Number.isFinite(src) && src > target + 0.12;
      const behind = Number.isFinite(src) && src < target - 0.05;
      if (ahead) {
        if (!v.paused) v.pause();
        seekTo(v, target, mapped.clip.id);
      } else if (behind && v.paused) {
        playVideo(v, false);
      }
      lastWall = now;
      useEditor.setState({
        playhead: ph,
        showBlack: covering,
        selectedId: mapped.clip.id,
      });
      if (performance.now() - lastSeekAt > 500) {
        covering = false;
        fileSeeking = false;
        seekTarget = null;
      } else {
        return;
      }
    } else {
      covering = false;
      fileSeeking = false;
      seekTarget = null;
    }
  }

  if (mapped && v && lastClipId === mapped.clip.id && !fileSeeking && !covering && !v.paused && !v.seeking) {
    const src = v.currentTime;
    if (sourceInClip(src, mapped.clip)) {
      const local = mapped.clip.timelineStart + (src - mapped.clip.sourceStart);
      if (local < minPh - 0.02) {
        lastWall = now;
        covering = true;
        seekTarget = mapped.clip.sourceStart + (minPh - mapped.clip.timelineStart);
        destClipId = null;
        seekTo(v, seekTarget, mapped.clip.id);
        useEditor.setState({ playhead: minPh, showBlack: true, selectedId: mapped.clip.id });
        return;
      }
      lastWall = now;
      ph = Math.max(minPh, Math.min(clipEnd(mapped.clip) - 0.0005, local));
      minPh = ph;
      if (ph >= clipEnd(mapped.clip) - 0.001) {
        if (!v.paused) v.pause();
        ph = clipEnd(mapped.clip);
        minPh = ph;
        lastClipId = null;
      } else {
        useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
        return;
      }
    } else {
      if (!v.paused) v.pause();
      ph = Math.max(minPh, clipEnd(mapped.clip));
      minPh = ph;
      lastClipId = null;
    }
  } else if (!mapped) {
    const dt = lastWall ? Math.min(0.08, (now - lastWall) / 1000) : 0;
    lastWall = now;
    ph = Math.min(end, ph + dt);
    minPh = ph;
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
    minPh = ph;
    useEditor.setState({ playhead: ph, showBlack: true });
    if (v && !v.paused) v.pause();
    return;
  }

  minPh = Math.max(minPh, ph);
  useEditor.setState({ playhead: ph, showBlack: covering, selectedId: mapped.clip.id });
  if (!v) return;

  if (lastClipId !== mapped.clip.id) {
    lastClipId = mapped.clip.id;
    seekTo(v, mapped.source, mapped.clip.id);
    return;
  }
  if (v.paused && !fileSeeking && !covering && !v.seeking) playVideo(v, false);
}

function sourceInClip(src: number, clip: Clip) {
  return src >= clip.sourceStart - 0.05 && src < clip.sourceEnd - 0.03;
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

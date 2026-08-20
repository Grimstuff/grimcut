import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { clipDuration, formatTime, type Clip, type ClipKind } from "../core/types";
import { clipsOn, rulerDuration } from "../core/project";
import { useEditor } from "../store/editorStore";
import { Waveform } from "./Waveform";
import { startHotkeys } from "../lib/hotkeys";
import { noteUserSeek, syncPreviewToPlayhead } from "../lib/playbackClock";
import { TransportBar } from "./TransportBar";

type Drag =
  | { kind: "seek"; pps: number; total: number }
  | { kind: "pan"; startX: number; view0: number }
  | { kind: "box"; track: ClipKind; a: number; b: number; pps: number; total: number }
  | {
      kind: "move" | "trimL" | "trimR";
      id: string;
      startX: number;
      orig: number;
      before: Clip[];
      pps: number;
    };

function seekVideo(t: number) {
  noteUserSeek();
  useEditor.getState().setPlayhead(t);
  syncPreviewToPlayhead();
}

const GUTTER = 0;
const NO_KEYFRAMES: number[] = [];
const LISTEN = "__grimcutTlListen";

type ListenWin = Window & {
  [LISTEN]?: { move: (e: Event) => void; up: (e: Event) => void };
};

let drag: Drag | null = null;
let lastClickAt = 0;
let lastClickX = 0;
let pendingScrollLeft: number | null = null;
let scrollerEl: HTMLDivElement | null = null;
let trackWNow = 800;
let applyLock: (v: { pps: number; total: number } | null) => void = () => {};
const metrics = { pps: 80, total: 1 };

function timeAt(clientX: number, frozen?: { pps: number; total: number }) {
  const el = scrollerEl;
  if (!el) return 0;
  const m = frozen ?? metrics;
  const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - GUTTER;
  return Math.max(0, Math.min(m.total, x / m.pps));
}

/** Unclamped — drop ghosts can land past the current ruler. */
export function timelineTimeAt(clientX: number) {
  const el = scrollerEl;
  if (!el) return 0;
  const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - GUTTER;
  return Math.max(0, x / Math.max(metrics.pps, 0.001));
}

export function dropClientX(physicalX: number) {
  const dpr = window.devicePixelRatio || 1;
  return physicalX / dpr;
}

function finishDrag() {
  const d = drag;
  drag = null;
  applyLock(null);
  if (!d) return;
  const st = useEditor.getState();
  if (d.kind === "move" || d.kind === "trimL" || d.kind === "trimR") {
    st.commit(d.before, d.kind === "move" ? "Move" : "Trim");
    const p = st.project;
    if (p) {
      const newTotal = Math.max(rulerDuration(p), 0.1);
      const z = (d.pps * newTotal) / trackWNow;
      if (z > 1.02 && Math.abs(z - st.zoom) > 0.02) {
        useEditor.setState({ zoom: z });
      }
    }
  }
  if (d.kind === "box") {
    const a = Math.min(d.a, d.b);
    const b = Math.max(d.a, d.b);
    st.setRange(b - a > 0.04 ? { start: a, end: b, kind: d.track } : null);
  }
}

function onDragMove(e: { clientX: number; buttons?: number }) {
  const d = drag;
  if (!d) return;
  if ("buttons" in e && e.buttons === 0) {
    finishDrag();
    return;
  }
  if (d.kind === "seek") {
    seekVideo(timeAt(e.clientX, d));
    return;
  }
  if (d.kind === "box") {
    const t = timeAt(e.clientX, d);
    drag = { ...d, b: t };
    useEditor.getState().setRange({ start: Math.min(d.a, t), end: Math.max(d.a, t), kind: d.track });
    return;
  }
  if (d.kind === "pan" && scrollerEl) {
    scrollerEl.scrollLeft = d.view0 - (e.clientX - d.startX);
    return;
  }
  if (d.kind !== "move" && d.kind !== "trimL" && d.kind !== "trimR") return;
  const delta = (e.clientX - d.startX) / d.pps;
  const snapSec = Math.min(0.25, Math.max(0.05, 10 / d.pps));
  const edgeSnap = Math.min(0.18, Math.max(0.03, 7 / d.pps));
  const st = useEditor.getState();
  if (d.kind === "trimL") st.liveTrim(d.id, "left", d.orig + delta, edgeSnap, d.before);
  if (d.kind === "trimR") st.liveTrim(d.id, "right", d.orig + delta, edgeSnap, d.before);
  if (d.kind === "move") st.liveMove(d.id, d.orig + delta, snapSec, d.before);
}

function ensureDragListeners() {
  startHotkeys();
  const w = window as ListenWin;
  if (w[LISTEN]) {
    window.removeEventListener("pointermove", w[LISTEN].move, true);
    window.removeEventListener("mousemove", w[LISTEN].move, true);
    window.removeEventListener("pointerup", w[LISTEN].up, true);
    window.removeEventListener("mouseup", w[LISTEN].up, true);
    window.removeEventListener("pointercancel", w[LISTEN].up, true);
  }
  const move = (e: Event) => onDragMove(e as MouseEvent);
  const up = () => finishDrag();
  w[LISTEN] = { move, up };
  window.addEventListener("pointermove", move, true);
  window.addEventListener("mousemove", move, true);
  window.addEventListener("pointerup", up, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("pointercancel", up, true);
}

function isRapidSecondClick(e: { clientX: number; button: number; detail?: number }) {
  if (e.button !== 0) return false;
  const now = performance.now();
  const second = now - lastClickAt < 450 && Math.abs(e.clientX - lastClickX) < 14;
  lastClickAt = now;
  lastClickX = e.clientX;
  return second || (e.detail ?? 0) >= 2;
}

function armDrag(e: PointerEvent, next: Drag, lock?: { pps: number; total: number }) {
  e.stopPropagation();
  drag = next;
  if (lock) applyLock(lock);
  try {
    scrollerEl?.setPointerCapture(e.pointerId);
  } catch {
    /* not capturable */
  }
  try {
    window.focus();
    (document.querySelector(".app") as HTMLElement | null)?.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

export function Timeline() {
  const scroller = useRef<HTMLDivElement>(null);
  const [trackW, setTrackW] = useState(800);
  trackWNow = trackW;
  const [lock, setLock] = useState<{ pps: number; total: number } | null>(null);
  applyLock = setLock;

  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const zoom = useEditor((s) => s.zoom);
  const keyframes = useEditor((s) => s.media?.keyframeTimes ?? NO_KEYFRAMES);
  const range = useEditor((s) => s.range);
  const peaks = useEditor((s) => s.peaks);
  const overlayPeaks = useEditor((s) => s.overlayPeaks);
  const overlayMedia = useEditor((s) => s.overlayMedia);
  const peaksByPath = useEditor((s) => s.peaksByPath);
  const mediaByPath = useEditor((s) => s.mediaByPath);
  const dropGhost = useEditor((s) => s.dropGhost);
  const playing = useEditor((s) => s.playing);
  const [tlH, setTlH] = useState(192);
  const splitDrag = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    const measure = () => {
      const el = scroller.current;
      if (!el) return;
      const next = Math.max(200, Math.floor(el.clientWidth - GUTTER));
      setTrackW((w) => (w === next ? w : next));
    };
    measure();
    const el = scroller.current;
    const ro = el ? new ResizeObserver(measure) : null;
    if (el && ro) ro.observe(el);
    return () => ro?.disconnect();
  }, [project]);

  const total = Math.max(project ? rulerDuration(project) : 1, 0.1);
  const livePps = (trackW / total) * zoom;
  const pps = lock?.pps ?? livePps;
  const ghostEnd = dropGhost ? dropGhost.start + Math.max(dropGhost.duration, 0.4) : 0;
  const layoutTotal = lock ? Math.max(lock.total, total) : Math.max(total, ghostEnd);
  const fitted = zoom <= 1.001 && !lock && !dropGhost;
  const width = fitted ? trackW : Math.ceil(layoutTotal * pps);

  metrics.pps = pps;
  metrics.total = total;

  useEffect(() => {
    ensureDragListeners();
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      if (!vertical) {
        el.scrollLeft += e.deltaX;
        return;
      }
      const t = timeAt(e.clientX);
      const xInView = e.clientX - el.getBoundingClientRect().left;
      const factor = e.deltaY > 0 ? 0.82 : 1.22;
      const st = useEditor.getState();
      const nextZ = Math.max(1, Math.min(256, st.zoom * factor));
      const newPps = (trackWNow / Math.max(metrics.total, 0.1)) * nextZ;
      pendingScrollLeft = Math.max(0, t * newPps + GUTTER - xInView);
      st.setZoom(nextZ, t);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [project]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || pendingScrollLeft == null) return;
    el.scrollLeft = pendingScrollLeft;
    pendingScrollLeft = null;
  });

  useEffect(() => {
    const el = scroller.current;
    if (!el || !project) return;
    if (fitted) {
      el.scrollLeft = 0;
      return;
    }
    if (!playing) return;
    const x = playhead * metrics.pps + GUTTER;
    const pad = 48;
    if (x < el.scrollLeft + pad) el.scrollLeft = Math.max(0, x - pad);
    else if (x > el.scrollLeft + el.clientWidth - pad) el.scrollLeft = x - el.clientWidth + pad;
  }, [playhead, project, fitted, playing]);

  if (!project) return null;

  const sliceAtClick = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag = null;
    applyLock(null);
    const st = useEditor.getState();
    st.setRange(null);
    st.slice();
  };

  const startBox = (kind: ClipKind, e: PointerEvent) => {
    if ((e.target as HTMLElement).closest(".handle, .clip-grip, .playhead-hit, .link-btn")) return;
    if (e.button === 1) {
      armDrag(e, { kind: "pan", startX: e.clientX, view0: scrollerEl?.scrollLeft ?? 0 });
      return;
    }
    if (e.button !== 0) return;
    if (isRapidSecondClick(e)) {
      sliceAtClick(e);
      return;
    }
    const t = timeAt(e.clientX);
    armDrag(e, { kind: "box", track: kind, a: t, b: t, pps, total }, { pps, total });
    useEditor.getState().setRange({ start: t, end: t, kind });
    seekVideo(t);
  };

  const startEdit = (kind: "move" | "trimL" | "trimR", clip: Clip, e: PointerEvent, orig: number) => {
    if (e.button !== 0) return;
    useEditor.getState().select(clip.id);
    armDrag(
      e,
      {
        kind,
        id: clip.id,
        startX: e.clientX,
        orig,
        before: useEditor.getState().snapshot() ?? [],
        pps,
      },
      { pps, total },
    );
  };

  const renderLane = (kind: ClipKind) => {
    const base = clipsOn(project, kind, "base");
    const over = clipsOn(project, kind, "over");
    return (
      <div
        className={`lane lane-${kind}`}
        onPointerDown={(e) => startBox(kind, e)}
      >
        <div className="lane-body" style={{ width }}>
          {base.map((c) => (
            <ClipView
              key={c.id}
              clip={c}
              pps={pps}
              selected={c.id === selectedId}
              peaks={kind === "audio" ? peaks : []}
              sourceDuration={project.sourceDuration}
              keyframes={keyframes}
              onMove={(e) => startEdit("move", c, e, c.timelineStart)}
              onRange={(e) => startBox(kind, e)}
              onTrimL={(e) => startEdit("trimL", c, e, c.sourceStart)}
              onTrimR={(e) => startEdit("trimR", c, e, c.sourceEnd)}
            />
          ))}
          {over.map((c) => (
            <ClipView
              key={c.id}
              clip={c}
              pps={pps}
              selected={c.id === selectedId}
              overlay
              peaks={
                kind === "audio"
                  ? c.sourcePath
                    ? (peaksByPath[c.sourcePath] ?? overlayPeaks)
                    : peaks
                  : []
              }
              sourceDuration={
                c.sourcePath && mediaByPath[c.sourcePath]
                  ? mediaByPath[c.sourcePath].duration
                  : c.sourcePath && overlayMedia
                    ? overlayMedia.duration
                    : project.sourceDuration
              }
              keyframes={
                c.sourcePath && mediaByPath[c.sourcePath]
                  ? mediaByPath[c.sourcePath].keyframeTimes
                  : c.sourcePath && overlayMedia
                    ? overlayMedia.keyframeTimes
                    : keyframes
              }
              onMove={(e) => startEdit("move", c, e, c.timelineStart)}
              onRange={(e) => startBox(kind, e)}
              onTrimL={(e) => startEdit("trimL", c, e, c.sourceStart)}
              onTrimR={(e) => startEdit("trimR", c, e, c.sourceEnd)}
            />
          ))}
          {range && range.kind === kind ? (
            <div
              className="range-box"
              style={{
                left: Math.min(range.start, range.end) * pps,
                width: Math.max(2, Math.abs(range.end - range.start) * pps),
              }}
            />
          ) : null}
          {dropGhost && (kind === "video" || dropGhost.hasAudio) ? (
            <div
              className="clip overlay drop-ghost"
              style={{
                left: dropGhost.start * pps,
                width: Math.max(12, Math.max(dropGhost.duration, 0.4) * pps),
              }}
            >
              <span className="layer-tag">2</span>
              <span className="clip-label">
                {dropGhost.probing ? "…" : formatTime(dropGhost.duration)} · {dropGhost.name}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    );
  };

  return (
    <div className="timeline-dock" style={{ height: tlH }}>
      <div
        className="tl-split"
        title="Drag to resize timeline"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          splitDrag.current = { y: e.clientY, h: tlH };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = splitDrag.current;
          if (!d) return;
          const max = Math.round(window.innerHeight * 0.72);
          setTlH(Math.max(176, Math.min(max, d.h - (e.clientY - d.y))));
        }}
        onPointerUp={() => {
          splitDrag.current = null;
        }}
      />
      <div className="timeline">
      <TransportBar />
      <div
        ref={(el) => {
          scroller.current = el;
          scrollerEl = el;
        }}
        className={`tl-scroll${fitted ? " is-fitted" : ""}`}
        onPointerMove={(e) => onDragMove(e)}
        onPointerUp={() => finishDrag()}
      >
        {renderLane("video")}
        {renderLane("audio")}
        <div
          className="playhead-hit"
          style={{ left: playhead * pps + GUTTER }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            if (isRapidSecondClick(e)) {
              sliceAtClick(e);
              return;
            }
            seekVideo(timeAt(e.clientX));
            armDrag(e, { kind: "seek", pps, total }, { pps, total });
          }}
        />
        <div className="playhead-full" style={{ left: playhead * pps + GUTTER }} />
      </div>
      </div>
    </div>
  );
}

function ClipView({
  clip,
  pps,
  selected,
  overlay,
  peaks,
  sourceDuration,
  keyframes,
  onMove,
  onRange,
  onTrimL,
  onTrimR,
}: {
  clip: Clip;
  pps: number;
  selected: boolean;
  overlay?: boolean;
  peaks: number[];
  sourceDuration: number;
  keyframes: number[];
  onMove: (e: PointerEvent) => void;
  onRange: (e: PointerEvent) => void;
  onTrimL: (e: PointerEvent) => void;
  onTrimR: (e: PointerEvent) => void;
}) {
  const dur = clipDuration(clip);
  const ticks: number[] = [];
  let lastX = -99;
  for (const kf of keyframes) {
    if (kf < clip.sourceStart - 0.001 || kf > clip.sourceEnd + 0.001) continue;
    const x = ((kf - clip.sourceStart) / Math.max(dur, 0.001)) * 100;
    const px = (kf - clip.sourceStart) * pps;
    if (px - lastX < 4) continue;
    lastX = px;
    ticks.push(x);
  }
  return (
    <div
      className={`clip ${clip.kind}${selected ? " selected" : ""}${overlay ? " overlay" : ""}`}
      style={{
        left: clip.timelineStart * pps,
        width: Math.max(dur * pps, 8),
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.altKey) onMove(e);
        else onRange(e);
      }}
      title={`${clip.kind} ${overlay ? "overlay (2nd layer)" : "base"} — drag to select, top box to move`}
    >
      <div
        className="clip-grip"
        title="Drag to move clip (or Alt+drag)"
        onPointerDown={(e) => {
          e.stopPropagation();
          onMove(e);
        }}
      />
      <div className="handle left" onPointerDown={onTrimL} />
      {ticks.map((x) => (
        <span key={x} className="kf-tick" style={{ left: `${x}%` }} />
      ))}
      {clip.kind === "audio" ? <Waveform clip={clip} peaks={peaks} sourceDuration={sourceDuration} /> : (
        <span className="clip-label">{formatTime(dur)}</span>
      )}
      {overlay ? (
        <span className="layer-tag" title="Overlay (2nd layer)">
          2
        </span>
      ) : null}
      {clip.linkGroup ? <span className="link-dot" title="Linked A/V" /> : null}
      <div className="handle right" onPointerDown={onTrimR} />
    </div>
  );
}

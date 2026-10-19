import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { clipDuration, clipEffects, clipEnd, formatTime, MIN_CLIP, type Clip, type ClipKind, type ClipSpan } from "../core/types";
import { clipsOn, partner, rulerDuration } from "../core/project";
import { collectLaneSpans, extractSpans } from "../core/edits";
import { useEditor } from "../store/editorStore";
import { Waveform } from "./Waveform";
import { Filmstrip } from "./Filmstrip";
import { startHotkeys } from "../lib/hotkeys";
import { noteUserSeek, setScrubPreview, syncPreviewToPlayhead } from "../lib/playbackClock";
import { TransportBar } from "./TransportBar";

type Drag =
  | { kind: "seek"; pps: number; total: number }
  | { kind: "pan"; startX: number; view0: number }
  | {
      kind: "box";
      track: ClipKind;
      a: number;
      b: number;
      pps: number;
      total: number;
      clipId?: string;
      add?: boolean;
      baseSel?: ClipSpan[];
    }
  | {
      kind: "move" | "trimL" | "trimR";
      id: string;
      startX: number;
      orig: number;
      before: Clip[];
      pps: number;
      sel?: ClipSpan[];
      extracted?: boolean;
      work?: Clip[];
      seedIds?: string[];
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
let holdView = false;
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

function scrollToPlayhead() {
  const el = scrollerEl;
  if (!el || useEditor.getState().zoom <= 1.001) return;
  const x = useEditor.getState().playhead * metrics.pps + GUTTER;
  const pad = Math.min(120, Math.max(48, el.clientWidth * 0.15));
  el.scrollLeft = Math.max(0, x - pad);
}

function finishDrag() {
  const d = drag;
  drag = null;
  applyLock(null);
  holdView = false;
  if (useEditor.getState().playing) scrollToPlayhead();
  if (!d) return;
  if (d.kind === "trimL" || d.kind === "trimR") setScrubPreview(null);
  const st = useEditor.getState();
  if (d.kind === "box") {
    const tiny = Math.abs(d.b - d.a) < 0.04;
    if (tiny && !d.add) {
      st.commitGainDraft();
    }
    st.setRange(null);
  }
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
    const st = useEditor.getState();
    const p = st.project;
    st.setRange({ start: Math.min(d.a, t), end: Math.max(d.a, t), kind: d.track });
    if (p && Math.abs(t - d.a) >= 0.04) {
      const spans = collectLaneSpans(p, d.track, d.a, t);
      st.setSelLane(d.track);
      st.setClipSel(d.add ? [...(d.baseSel ?? []), ...spans] : spans);
    }
    return;
  }
  if (d.kind === "pan" && scrollerEl) {
    scrollerEl.scrollLeft = d.view0 - (e.clientX - d.startX);
    return;
  }
  if (d.kind !== "move" && d.kind !== "trimL" && d.kind !== "trimR") return;
  const delta = (e.clientX - d.startX) / d.pps;
  const snapSec = Math.min(0.3, Math.max(0.04, 12 / d.pps));
  const edgeSnap = Math.min(0.22, Math.max(0.025, 8.4 / d.pps));
  const st = useEditor.getState();
  if (d.kind === "trimL") st.liveTrim(d.id, "left", d.orig + delta, edgeSnap, d.before);
  if (d.kind === "trimR") st.liveTrim(d.id, "right", d.orig + delta, edgeSnap, d.before);
  if (d.kind === "move" && d.sel?.length) {
    if (!d.extracted && Math.abs(delta) > 0.03) {
      const p0 = { ...st.project!, clips: d.before };
      const ex = extractSpans(p0, d.sel);
      const orig = d.before.find((c) => c.id === d.id);
      const span = d.sel.find((s) => s.clipId === d.id);
      const piece =
        (orig &&
          ex.clips.find(
            (c) =>
              ex.ids.includes(c.id) &&
              c.kind === orig.kind &&
              c.layer === orig.layer &&
              span &&
              Math.abs(c.timelineStart - span.start) < 0.05,
          )) ??
        ex.clips.find((c) => c.id === d.id) ??
        ex.clips.find((c) => ex.ids.includes(c.id));
      d.extracted = true;
      d.work = ex.clips;
      d.seedIds = ex.ids;
      if (piece) {
        d.id = piece.id;
        d.orig = piece.timelineStart;
      }
    }
    if (d.extracted && d.work && d.seedIds) {
      st.liveMoveSel(d.id, d.orig, d.orig + delta, snapSec, d.work, d.seedIds);
    }
  } else if (d.kind === "move") st.liveMove(d.id, d.orig + delta, snapSec, d.before);
  if (d.kind === "trimL" || d.kind === "trimR") {
    const c = st.project?.clips.find((x) => x.id === d.id);
    if (c) {
      const fps = st.media?.frameRate || 30;
      const frame = 1 / Math.max(1, fps);
      const t = d.kind === "trimL" ? c.timelineStart : Math.max(c.timelineStart, clipEnd(c) - frame);
      setScrubPreview(t);
    }
  }
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
  if (useEditor.getState().playing) holdView = true;
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
  const clipSel = useEditor((s) => s.clipSel);
  const selLane = useEditor((s) => s.selLane);
  const playing = useEditor((s) => s.playing);
  const [scrollN, setScrollN] = useState({ left: 0, cw: 800, sw: 800 });

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

  useEffect(() => {
    if (selLane !== "audio") return;
    const onDoc = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest(".gain-hud")) return;
      useEditor.getState().commitGainDraft();
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [selLane]);

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
    if (!el) return;
    const sync = () =>
      setScrollN({ left: el.scrollLeft, cw: el.clientWidth, sw: el.scrollWidth });
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [width, fitted, project]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !project) return;
    if (fitted) {
      el.scrollLeft = 0;
      return;
    }
    if (!playing || drag || holdView) return;
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

  const startBox = (kind: ClipKind, e: PointerEvent, clipId?: string) => {
    if ((e.target as HTMLElement).closest(".handle, .clip-grip, .playhead-hit, .link-btn, .av-link, .anim-key")) return;
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
    const st = useEditor.getState();
    if (st.playing) {
      seekVideo(t);
      armDrag(e, { kind: "seek", pps, total });
      return;
    }
    armDrag(e, {
      kind: "box",
      track: kind,
      a: t,
      b: t,
      pps,
      total,
      clipId,
      add: e.shiftKey,
      baseSel: st.clipSel,
    });
    st.commitGainDraft();
    st.setSelLane(kind);
    st.setRange({ start: t, end: t, kind });
    seekVideo(t);
  };

  const startEdit = (kind: "move" | "trimL" | "trimR", clip: Clip, e: PointerEvent, orig: number) => {
    if (e.button !== 0) return;
    const st = useEditor.getState();
    st.select(clip.id);
    if ((kind === "trimL" || kind === "trimR") && st.playing) st.setPlaying(false);
    const hitSel = kind === "move" && st.clipSel.some((s) => s.clipId === clip.id);
    if (kind === "move" && !hitSel) st.setClipSel([]);
    armDrag(
      e,
      {
        kind,
        id: clip.id,
        startX: e.clientX,
        orig,
        before: st.snapshot() ?? [],
        pps,
        sel: hitSel ? st.clipSel : undefined,
      },
      { pps, total },
    );
  };

  const renderLane = (kind: ClipKind) => {
    const extra = kind === "video" ? "text" : null;
    const base = [
      ...clipsOn(project, kind, "base"),
      ...(extra ? clipsOn(project, extra, "base") : []),
    ].sort((a, b) => a.timelineStart - b.timelineStart);
    const over = [
      ...clipsOn(project, kind, "over"),
      ...(extra ? clipsOn(project, extra, "over") : []),
    ].sort((a, b) => a.timelineStart - b.timelineStart);
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
              sel={clipSel.filter((s) => s.clipId === c.id)}
              peaks={kind === "audio" ? peaks : []}
              sourceDuration={project.sourceDuration}
              keyframes={keyframes}
              onMove={(e) => startEdit("move", c, e, c.timelineStart)}
              onRange={(e) => startBox(kind, e, c.id)}
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
              sel={clipSel.filter((s) => s.clipId === c.id)}
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
              onRange={(e) => startBox(kind, e, c.id)}
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
          {dropGhost &&
          ((kind === "video" && !dropGhost.audioOnly) || (kind === "audio" && (dropGhost.audioOnly || dropGhost.hasAudio))) ? (
            <div
              className={`clip overlay drop-ghost${kind === "audio" ? " audio" : ""}`}
              style={{
                left: dropGhost.start * pps,
                width: Math.max(12, Math.max(dropGhost.duration, 0.05) * pps),
              }}
            >
              <span className="layer-tag">2</span>
              <span className="clip-label">
                {dropGhost.probing ? "…" : formatTime(dropGhost.duration)} · {dropGhost.name}
              </span>
            </div>
          ) : null}
          {kind === "video" ? <MotionKeys clips={[...base, ...over]} pps={pps} /> : null}
        </div>
      </div>
    );
  };

  return (
    <div className="timeline-dock">
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
        <AudioGainHud pps={pps} />
        <AvLinks pps={pps} />
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
            armDrag(e, { kind: "seek", pps, total });
          }}
        />
        <div className="playhead-full" style={{ left: playhead * pps + GUTTER }} />
      </div>
      <HScroll fitted={fitted} metrics={scrollN} scroller={scroller} />
      </div>
    </div>
  );
}

function HScroll({
  fitted,
  metrics,
  scroller,
}: {
  fitted: boolean;
  metrics: { left: number; cw: number; sw: number };
  scroller: { current: HTMLDivElement | null };
}) {
  const bar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const jump = (clientX: number) => {
    const el = scroller.current;
    const track = bar.current;
    if (!el || !track) return;
    const r = track.getBoundingClientRect();
    const max = Math.max(1, el.scrollWidth - el.clientWidth);
    const thumbPx = Math.max(28, (el.clientWidth / Math.max(el.scrollWidth, 1)) * r.width);
    const x = clientX - r.left - thumbPx / 2;
    const t = Math.max(0, Math.min(1, x / Math.max(1, r.width - thumbPx)));
    el.scrollLeft = t * max;
  };
  const overflow = metrics.sw > metrics.cw + 2 && !fitted;
  const thumbPct = overflow ? Math.max(8, (metrics.cw / metrics.sw) * 100) : 100;
  const leftPct = overflow ? (metrics.left / Math.max(1, metrics.sw - metrics.cw)) * (100 - thumbPct) : 0;
  return (
    <div
      ref={bar}
      className={`tl-hscroll${overflow ? "" : " is-full"}`}
      title="Scroll timeline"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        dragging.current = true;
        holdView = true;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        jump(e.clientX);
      }}
      onPointerMove={(e) => {
        if (dragging.current) jump(e.clientX);
      }}
      onPointerUp={() => {
        dragging.current = false;
        holdView = false;
        if (useEditor.getState().playing) scrollToPlayhead();
      }}
    >
      <div className="tl-hscroll-thumb" style={{ width: `${thumbPct}%`, left: `${leftPct}%` }} />
    </div>
  );
}

function MotionKeys({ clips, pps }: { clips: Clip[]; pps: number }) {
  const selectedAnimId = useEditor((s) => s.selectedAnimId);
  const marks = clips.filter((c) => c.kind !== "audio" && c.anim?.length);
  if (!marks.length) return null;
  return (
    <>
      {marks.map((clip) => {
        const keys = [...(clip.anim ?? [])].sort((a, b) => a.t - b.t);
        const over = clip.layer === "over";
        const first = keys[0].t;
        const last = keys[keys.length - 1].t;
        return keys.length > 1 ? (
          <div
            key={`${clip.id}-path`}
            className={`anim-path${over ? " is-over" : ""}`}
            style={{ left: (clip.timelineStart + first) * pps, width: (last - first) * pps }}
          />
        ) : null;
      })}
      {marks.map((clip) =>
        [...(clip.anim ?? [])]
          .sort((a, b) => a.t - b.t)
          .map((k) => (
            <button
              key={k.id}
              type="button"
              className={`anim-key${clip.layer === "over" ? " is-over" : ""}${selectedAnimId === k.id ? " is-on" : ""}${k.channels?.blend === false ? " is-step" : ""}`}
              style={{ left: (clip.timelineStart + k.t) * pps }}
              title={`Motion key on ${clip.layer === "over" ? "overlay (layer 2)" : "main track"} — drag to move in time. Delete or right-click removes it.`}
              onPointerDown={(e) => {
                if (e.button === 1) return;
                e.stopPropagation();
                e.preventDefault();
                if (e.button !== 0) return;
                const st = useEditor.getState();
                st.selectAnimKey(clip.id, k.id);
                const startX = e.clientX;
                const t0 = k.t;
                const before = st.snapshot() ?? [];
                let moved = false;
                const move = (ev: globalThis.PointerEvent) => {
                  const dx = ev.clientX - startX;
                  if (Math.abs(dx) > 2) moved = true;
                  const dur = clipDuration(clip);
                  const nt = Math.max(0, Math.min(dur, t0 + dx / pps));
                  useEditor.getState().moveAnimKey(clip.id, k.id, nt);
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  if (moved) useEditor.getState().commit(before, "Move motion key");
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                useEditor.getState().removeAnimKey(clip.id, k.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                useEditor.getState().removeAnimKey(clip.id, k.id);
              }}
            />
          )),
      )}
    </>
  );
}

function ClipView({
  clip,
  pps,
  selected,
  sel,
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
  sel: ClipSpan[];
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
  const fxList = clipEffects(clip);
  const selectedEffectId = useEditor((s) => s.selectedEffectId);
  const gainDraft = useEditor((s) => s.gainDraft);
  const selLane = useEditor((s) => s.selLane);
  const kfOp = Math.min(1, Math.max(0, (pps - 4) / 10));
  const ticks: number[] = [];
  let lastX = -99;
  if (kfOp > 0.02) {
    for (const kf of keyframes) {
      if (kf < clip.sourceStart - 0.001 || kf > clip.sourceEnd + 0.001) continue;
      const x = ((kf - clip.sourceStart) / Math.max(dur, 0.001)) * 100;
      const px = (kf - clip.sourceStart) * pps;
      if (px - lastX < 4) continue;
      lastX = px;
      ticks.push(x);
    }
  }
  return (
    <div
      className={`clip ${clip.kind}${selected ? " selected" : ""}${overlay ? " overlay" : ""}`}
      style={{
        left: clip.timelineStart * pps,
        width: Math.max(dur * pps, 8),
        ["--kf-op" as string]: String(kfOp),
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        if (e.altKey) onMove(e);
        else onRange(e);
      }}
      title={`${clip.kind} ${overlay ? "overlay (2nd layer)" : "base"} — drag to select, top box to move`}
    >
      {sel.map((s) => (
        <span
          key={`${s.start}-${s.end}`}
          className="clip-sel"
          style={{
            left: (s.start - clip.timelineStart) * pps,
            width: Math.max(2, (s.end - s.start) * pps),
          }}
        />
      ))}
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
      {clip.kind === "audio" ? (
        <Waveform
          clip={clip}
          peaks={peaks}
          sourceDuration={sourceDuration}
          draft={selLane === "audio" ? sel.map((s) => ({ start: s.start, end: s.end, db: gainDraft })) : null}
        />
      ) : clip.kind === "video" ? (
        <Filmstrip clip={clip} pps={pps} />
      ) : (
        <span className="clip-label">
          {clip.text?.trim() || "Text"}
        </span>
      )}
      {fxList.length > 0 ? (
        <span className="clip-fx">
          {fxList.map((fx) => (
            <button
              key={fx.id}
              type="button"
              className={`clip-fx-btn${selectedEffectId === fx.id ? " is-on" : ""}`}
              title={fx.kind === "blur" ? "Gaussian blur — click to select" : fx.kind}
              onPointerDown={(e) => {
                e.stopPropagation();
                e.preventDefault();
                useEditor.getState().selectEffect(clip.id, fx.id);
              }}
            >
              <IconClipBlur />
            </button>
          ))}
        </span>
      ) : null}
      {overlay ? (
        <span className={`layer-tag${fxList.length ? " has-fx" : ""}`} title="Overlay (2nd layer)">
          2
        </span>
      ) : null}
      <div className="handle right" onPointerDown={onTrimR} />
    </div>
  );
}

function IconClipBlur() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      <circle cx="4" cy="5" r="2.2" fill="currentColor" opacity="0.35" />
      <circle cx="6.2" cy="5" r="2.2" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

function AudioGainHud({ pps }: { pps: number }) {
  const selLane = useEditor((s) => s.selLane);
  const clipSel = useEditor((s) => s.clipSel);
  const project = useEditor((s) => s.project);
  const gainDraft = useEditor((s) => s.gainDraft);
  if (selLane !== "audio" || !project || !clipSel.length) return null;
  const spans = clipSel.filter((s) => project.clips.find((c) => c.id === s.clipId)?.kind === "audio");
  if (!spans.length) return null;
  const a = Math.min(...spans.map((s) => s.start));
  const b = Math.max(...spans.map((s) => s.end));
  const left = ((a + b) / 2) * pps;
  const top = LANE_H + LANE_GAP + 8;
  return (
    <div
      className="gain-hud"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        type="range"
        min={-24}
        max={18}
        step={0.5}
        value={gainDraft}
        title="Selection gain"
        onChange={(e) => useEditor.getState().setGainDraft(Number(e.target.value))}
      />
      <span className="gain-hud-val">
        {gainDraft > 0 ? "+" : ""}
        {gainDraft.toFixed(1)} dB
      </span>
      <button type="button" className="gain-hud-x" title="Cancel gain change" onClick={() => useEditor.getState().cancelGainDraft()}>
        ×
      </button>
    </div>
  );
}

const LANE_H = 64;
const LANE_GAP = 4;

function overlapSec(a: Clip, b: Clip) {
  return Math.min(clipEnd(a), clipEnd(b)) - Math.max(a.timelineStart, b.timelineStart);
}

function AvLinks({ pps }: { pps: number }) {
  const project = useEditor((s) => s.project);
  if (!project) return null;
  const videos = project.clips.filter((c) => c.kind === "video");
  const audios = project.clips.filter((c) => c.kind === "audio");
  const pairs: { v: Clip; a: Clip; linked: boolean; start: number; end: number }[] = [];
  const usedA = new Set<string>();
  const usedV = new Set<string>();

  for (const v of videos) {
    const mate = partner(project, v);
    if (mate?.kind !== "audio") continue;
    const start = Math.max(v.timelineStart, mate.timelineStart);
    const end = Math.min(clipEnd(v), clipEnd(mate));
    if (end - start < 0.02) continue;
    pairs.push({ v, a: mate, linked: true, start, end });
    usedA.add(mate.id);
    usedV.add(v.id);
  }
  for (const v of videos) {
    if (usedV.has(v.id) || v.linkGroup) continue;
    let best: Clip | null = null;
    let bestO = MIN_CLIP;
    for (const a of audios) {
      if (usedA.has(a.id) || a.linkGroup || a.layer !== v.layer) continue;
      const o = overlapSec(v, a);
      if (o > bestO) {
        bestO = o;
        best = a;
      }
    }
    if (!best) continue;
    pairs.push({
      v,
      a: best,
      linked: false,
      start: Math.max(v.timelineStart, best.timelineStart),
      end: Math.min(clipEnd(v), clipEnd(best)),
    });
    usedA.add(best.id);
    usedV.add(v.id);
  }

  return (
    <div className="av-links">
      {pairs.map((p) => {
        const x = ((p.start + p.end) / 2) * pps + GUTTER - 9;
        const vOver = p.v.layer === "over";
        const aOver = p.a.layer === "over";
        const y1 = vOver ? 2 + LANE_H * 0.42 : 60;
        const y2 = LANE_H + LANE_GAP + (aOver ? 2 : 4);
        return (
          <button
            key={`${p.v.id}-${p.a.id}`}
            type="button"
            className={`av-link${p.linked ? " is-linked" : " is-open"}`}
            style={{ left: x, top: y1, height: Math.max(14, y2 - y1) }}
            title={p.linked ? "Unlink video and audio" : "Link video and audio"}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (p.linked) useEditor.getState().toggleLink(p.v.id);
              else useEditor.getState().linkPair(p.v.id, p.a.id);
            }}
          >
            <span className="av-link-line" />
            <span className="av-link-lock">{p.linked ? <IconLock /> : <IconUnlock />}</span>
          </button>
        );
      })}
    </div>
  );
}

function IconLock() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2.5" y="5.2" width="7" height="5.2" rx="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M4 5.2V3.6a2 2 0 0 1 4 0V5.2" />
    </svg>
  );
}

function IconUnlock() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2.5" y="5.2" width="7" height="5.2" rx="1.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M4 5.2V3.6a2 2 0 0 1 3.7-.9" />
    </svg>
  );
}

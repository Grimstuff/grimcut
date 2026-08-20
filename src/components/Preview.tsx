import { useEffect, useRef, useState, type PointerEvent as RE } from "react";
import { clipAt, clipSourcePath } from "../core/project";
import {
  canvasSnapPoints,
  clipDrawRect,
  clipXf,
  nearestPoint,
  pointInRotatedRect,
  rectToTransform,
  snapRotation,
} from "../core/canvas";
import { useEditor } from "../store/editorStore";
import { markVideoSeekDone, setOverlayVideo, setPreviewVideo, syncPreviewToPlayhead } from "../lib/playbackClock";
import type { Clip } from "../core/types";

type Corner = "nw" | "ne" | "sw" | "se";

type CanvasDrag =
  | { kind: "pan"; x: number; y: number; vx: number; vy: number }
  | {
      kind: "move";
      id: string;
      left0: number;
      top0: number;
      w: number;
      h: number;
      px: number;
      py: number;
      before: ReturnType<typeof snapshotClips>;
    }
  | { kind: "scale"; id: string; corner: Corner; ax: number; ay: number; rot: number; before: ReturnType<typeof snapshotClips> }
  | { kind: "rotate"; id: string; rot0: number; ang0: number; typed: string; before: ReturnType<typeof snapshotClips> };

function snapshotClips() {
  return useEditor.getState().snapshot() ?? [];
}

function cornerAnchor(rect: { x: number; y: number; w: number; h: number }, corner: Corner) {
  switch (corner) {
    case "se":
      return { ax: rect.x, ay: rect.y };
    case "sw":
      return { ax: rect.x + rect.w, ay: rect.y };
    case "ne":
      return { ax: rect.x, ay: rect.y + rect.h };
    case "nw":
      return { ax: rect.x + rect.w, ay: rect.y + rect.h };
  }
}

function srcSize(clip: Clip) {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return { w: 1920, h: 1080 };
  const path = clipSourcePath(p, clip);
  const m = st.mediaByPath[path] ?? (path === p.sourcePath ? st.media : st.overlayMedia);
  return { w: m?.width || 1920, h: m?.height || 1080 };
}

export function Preview() {
  const viewRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const overRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<CanvasDrag | null>(null);
  const [view, setView] = useState({ z: 1, x: 0, y: 0 });
  const [marksOn, setMarksOn] = useState(false);
  const [hotDot, setHotDot] = useState<{ x: number; y: number } | null>(null);
  const [rotHud, setRotHud] = useState<number | null>(null);
  const [rotTyped, setRotTyped] = useState(false);
  const previewUrl = useEditor((s) => s.previewUrl);
  const overlayUrl = useEditor((s) => s.overlayUrl);
  const pickOpen = useEditor((s) => s.pickOpen);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const playing = useEditor((s) => s.playing);

  useEffect(() => {
    const v = videoRef.current;
    setPreviewVideo(v ?? null);
    if (!v) return;
    const clear = () => markVideoSeekDone();
    v.addEventListener("seeked", clear);
    return () => v.removeEventListener("seeked", clear);
  }, [previewUrl]);

  useEffect(() => {
    const v = overRef.current;
    setOverlayVideo(v ?? null);
    if (!v) return;
    const clear = () => markVideoSeekDone();
    v.addEventListener("seeked", clear);
    return () => {
      v.removeEventListener("seeked", clear);
      setOverlayVideo(null);
    };
  }, [overlayUrl, project]);

  useEffect(() => {
    syncPreviewToPlayhead();
  }, [playhead, previewUrl, overlayUrl]);

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      setView((v) => {
        const factor = e.deltaY > 0 ? 0.9 : 1.12;
        const z = Math.min(8, Math.max(0.05, v.z * factor));
        return { z, x: mx - ((mx - v.x) / v.z) * z, y: my - ((my - v.y) / v.z) * z };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [previewUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const d = drag.current;
      if (!d || d.kind !== "rotate") return;
      if (e.key === "Escape") {
        d.typed = "";
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        d.typed = d.typed.slice(0, -1);
        const n = Number.parseFloat(d.typed);
        if (Number.isFinite(n)) {
          const clip = useEditor.getState().project?.clips.find((c) => c.id === d.id);
          if (clip) useEditor.getState().liveTransform(d.id, { ...clipXf(clip), rotation: n });
          setRotHud(n);
          setRotTyped(true);
        }
        return;
      }
      if (e.key === "-" || e.key === "." || (e.key >= "0" && e.key <= "9")) {
        e.preventDefault();
        d.typed += e.key;
        const n = Number.parseFloat(d.typed);
        if (Number.isFinite(n)) {
          const clip = useEditor.getState().project?.clips.find((c) => c.id === d.id);
          if (clip) useEditor.getState().liveTransform(d.id, { ...clipXf(clip), rotation: n });
          setRotHud(n);
          setRotTyped(true);
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    const el = viewRef.current;
    if (!el || !project) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const pad = 56;
      const z = Math.min((r.width - pad) / project.canvasWidth, (r.height - pad) / project.canvasHeight);
      setView({ z: Math.max(0.05, z), x: (r.width - project.canvasWidth * z) / 2, y: (r.height - project.canvasHeight * z) / 2 });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project?.canvasWidth, project?.canvasHeight, previewUrl]);

  if (!previewUrl || !project) {
    return (
      <div className="preview-wrap">
        <div className="drop-hint">
          <h1>Grimcut</h1>
          <p>Drop a video here or Open…</p>
          <p style={{ fontSize: 12, opacity: 0.7 }}>Simple cuts. Save. No encode maze.</p>
          <button type="button" className="menu-option" style={{ margin: "16px auto", width: "auto" }} onClick={() => void pickOpen()}>
            Open video…
          </button>
        </div>
      </div>
    );
  }

  const cw = project.canvasWidth;
  const ch = project.canvasHeight;
  const baseClip = clipAt(project, playhead, "video", "base");
  const overClip = clipAt(project, playhead, "video", "over");
  const selected = project.clips.find((c) => c.id === selectedId && c.kind === "video") ?? null;
  const selectedLive = selected && (selected.id === baseClip?.id || selected.id === overClip?.id) ? selected : null;

  const toCanvas = (clientX: number, clientY: number) => {
    const el = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left - view.x) / view.z, y: (clientY - r.top - view.y) / view.z };
  };

  const hitClip = (cx: number, cy: number): Clip | null => {
    const order = [overClip, baseClip].filter(Boolean) as Clip[];
    for (const c of order) {
      const sz = srcSize(c);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(c));
      if (pointInRotatedRect(cx, cy, rect)) return c;
    }
    return null;
  };

  const onPointerDown = (e: RE) => {
    if (e.button === 1 || e.altKey) {
      drag.current = { kind: "pan", x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    const pt = toCanvas(e.clientX, e.clientY);
    const hit = hitClip(pt.x, pt.y);
    const t = e.target as HTMLElement;
    if (t.closest(".bbox-rot") && selectedLive) {
      const sz = srcSize(selectedLive);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(selectedLive));
      drag.current = {
        kind: "rotate",
        id: selectedLive.id,
        rot0: clipXf(selectedLive).rotation,
        ang0: Math.atan2(pt.y - rect.cy, pt.x - rect.cx),
        typed: "",
        before: snapshotClips(),
      };
      setRotHud(clipXf(selectedLive).rotation);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const handle = t.closest(".bbox-handle") as HTMLElement | null;
    if (handle && selectedLive) {
      const corner = (handle.dataset.corner ?? "se") as Corner;
      const sz = srcSize(selectedLive);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(selectedLive));
      const a = cornerAnchor(rect, corner);
      drag.current = {
        kind: "scale",
        id: selectedLive.id,
        corner,
        ax: a.ax,
        ay: a.ay,
        rot: rect.rotation,
        before: snapshotClips(),
      };
      setMarksOn(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (hit) {
      useEditor.getState().select(hit.id);
      const sz = srcSize(hit);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(hit));
      drag.current = {
        kind: "move",
        id: hit.id,
        left0: rect.x,
        top0: rect.y,
        w: rect.w,
        h: rect.h,
        px: pt.x,
        py: pt.y,
        before: snapshotClips(),
      };
      setMarksOn(true);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    useEditor.getState().select(null);
  };

  const onPointerMove = (e: RE) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === "pan") {
      setView((v) => ({ ...v, x: d.vx + (e.clientX - d.x), y: d.vy + (e.clientY - d.y) }));
      return;
    }
    const pt = toCanvas(e.clientX, e.clientY);
    const p = useEditor.getState().project;
    const clip = p?.clips.find((c) => c.id === d.id);
    if (!p || !clip) return;
    const xf = clipXf(clip);
    const targets = canvasSnapPoints(cw, ch);
    const thresh = Math.max(2, 5 / view.z);
    if (d.kind === "move") {
      let left = d.left0 + (pt.x - d.px);
      let top = d.top0 + (pt.y - d.py);
      const corners = [
        { x: left, y: top },
        { x: left + d.w, y: top },
        { x: left, y: top + d.h },
        { x: left + d.w, y: top + d.h },
        { x: left + d.w / 2, y: top + d.h / 2 },
      ];
      let best: { dx: number; dy: number; dist: number; tx: number; ty: number } | null = null;
      for (const c of corners) {
        const n = nearestPoint(c.x, c.y, targets, thresh);
        if (n && (!best || n.dist < best.dist)) best = { dx: n.x - c.x, dy: n.y - c.y, dist: n.dist, tx: n.x, ty: n.y };
      }
      if (best) {
        left += best.dx;
        top += best.dy;
        setHotDot({ x: best.tx, y: best.ty });
      } else setHotDot(null);
      useEditor.getState().liveTransform(d.id, {
        ...xf,
        x: left + d.w / 2 - cw / 2,
        y: top + d.h / 2 - ch / 2,
      });
    } else if (d.kind === "scale") {
      const sz = srcSize(clip);
      let mx = pt.x;
      let my = pt.y;
      const hit = nearestPoint(mx, my, targets, thresh);
      if (hit) {
        mx = hit.x;
        my = hit.y;
        setHotDot({ x: hit.x, y: hit.y });
      } else setHotDot(null);
      let w = Math.max(4, Math.abs(mx - d.ax));
      let h = Math.max(4, Math.abs(my - d.ay));
      const free = e.shiftKey;
      if (!free) {
        const ar = sz.w / sz.h;
        if (w / h > ar) h = w / ar;
        else w = h * ar;
      }
      const left = mx < d.ax ? d.ax - w : d.ax;
      const top = my < d.ay ? d.ay - h : d.ay;
      useEditor.getState().liveTransform(
        d.id,
        rectToTransform(left, top, w, h, cw, ch, sz.w, sz.h, d.rot),
      );
    } else if (d.kind === "rotate") {
      const sz = srcSize(clip);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, xf);
      const ang = Math.atan2(pt.y - rect.cy, pt.x - rect.cx);
      const raw = d.rot0 + ((ang - d.ang0) * 180) / Math.PI;
      const typed = Number.parseFloat(d.typed);
      if (d.typed && Number.isFinite(typed)) {
        let delta = raw - typed;
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;
        if (Math.abs(delta) < 10) {
          setRotHud(typed);
          setRotTyped(true);
          return;
        }
        d.typed = "";
        setRotTyped(false);
      }
      const rotation = snapRotation(raw, 3);
      setRotHud(rotation);
      setRotTyped(false);
      useEditor.getState().liveTransform(d.id, { ...xf, rotation });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setMarksOn(false);
    setHotDot(null);
    setRotHud(null);
    setRotTyped(false);
    if (d && d.kind !== "pan") useEditor.getState().commit(d.before, "Transform");
  };

  const placeVideo = (clip: Clip | null) => {
    if (!clip) return { display: "none" as const };
    const sz = srcSize(clip);
    const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(clip));
    return {
      display: "block" as const,
      left: rect.x,
      top: rect.y,
      width: rect.w,
      height: rect.h,
      transform: `rotate(${rect.rotation}deg)`,
    };
  };

  const bbox = selectedLive
    ? clipDrawRect(srcSize(selectedLive).w, srcSize(selectedLive).h, cw, ch, clipXf(selectedLive))
    : null;

  return (
    <div className="preview-wrap is-canvas">
      <div
        ref={viewRef}
        className="canvas-view"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Wheel zoom · Alt-drag pan · Shift+scale to stretch"
      >
        <div className="canvas-space" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          <div className="canvas-stage" style={{ width: cw, height: ch }}>
            <video
              ref={(el) => {
                videoRef.current = el;
                setPreviewVideo(el);
              }}
              className="layer-vid is-base"
              src={previewUrl}
              tabIndex={-1}
              playsInline
              preload="auto"
              disablePictureInPicture
              style={placeVideo(baseClip)}
            />
            <video
              ref={(el) => {
                overRef.current = el;
                setOverlayVideo(el);
              }}
              className="layer-vid is-over"
              src={overClip ? urlOf(overClip) ?? overlayUrl ?? undefined : overlayUrl ?? undefined}
              tabIndex={-1}
              playsInline
              preload="auto"
              disablePictureInPicture
              style={placeVideo(overClip)}
            />
          </div>
            <div className={`canvas-guides${marksOn ? " is-on" : ""}`} style={{ width: cw, height: ch }}>
              {canvasSnapPoints(cw, ch).map((p) => {
                const hot = hotDot && Math.abs(hotDot.x - p.x) < 0.5 && Math.abs(hotDot.y - p.y) < 0.5;
                const s = Math.max(7, 7 / view.z);
                return (
                  <div
                    key={`${p.x},${p.y}`}
                    className={`snap-dot${hot ? " is-hot" : ""}`}
                    style={{ left: p.x, top: p.y, width: s, height: s }}
                  />
                );
              })}
            </div>
            {bbox ? (
              <div
                className="bbox"
                style={{
                  left: bbox.x,
                  top: bbox.y,
                  width: bbox.w,
                  height: bbox.h,
                  transform: `rotate(${bbox.rotation}deg)`,
                }}
              >
                <span className="bbox-rot" title="Rotate — drag, or type degrees">
                  {rotHud != null ? (
                    <span className={`rot-ghost${rotTyped ? " is-typed" : ""}`} style={{ transform: `translateX(-50%) rotate(${-bbox.rotation}deg) scale(${1 / view.z})` }}>
                      {rotHud.toFixed(1)}°
                    </span>
                  ) : null}
                </span>
                <span className="bbox-handle nw" data-corner="nw" />
                <span className="bbox-handle ne" data-corner="ne" />
                <span className="bbox-handle sw" data-corner="sw" />
                <span className="bbox-handle se" data-corner="se" />
              </div>
            ) : null}
        </div>
      </div>
      <div className="canvas-meta">
        {cw}×{ch}
        {playing ? " · playing" : ""}
        {selectedLive ? ` · ${selectedLive.layer === "over" ? "layer 2" : "layer 1"}` : ""}
      </div>
    </div>
  );
}

function urlOf(clip: Clip) {
  const st = useEditor.getState();
  const p = st.project;
  if (!p) return null;
  const path = clipSourcePath(p, clip);
  return st.previewByPath[path] ?? (path === p.sourcePath ? st.previewUrl : st.overlayUrl);
}

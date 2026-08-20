import { useEffect, useRef, useState, type PointerEvent as RE } from "react";
import { clipAt, clipSourcePath } from "../core/project";
import { clipDrawRect, clipXf, pointInRotatedRect } from "../core/canvas";
import { useEditor } from "../store/editorStore";
import { markVideoSeekDone, setOverlayVideo, setPreviewVideo, syncPreviewToPlayhead } from "../lib/playbackClock";
import type { Clip } from "../core/types";

type CanvasDrag =
  | { kind: "pan"; x: number; y: number; vx: number; vy: number }
  | { kind: "move"; id: string; x0: number; y0: number; px: number; py: number; before: ReturnType<typeof snapshotClips> }
  | { kind: "scale"; id: string; scale0: number; dist0: number; before: ReturnType<typeof snapshotClips> }
  | { kind: "rotate"; id: string; rot0: number; ang0: number; before: ReturnType<typeof snapshotClips> };

function snapshotClips() {
  return useEditor.getState().snapshot() ?? [];
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
    const el = viewRef.current;
    if (!el || !project) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const pad = 28;
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
        before: snapshotClips(),
      };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (t.closest(".bbox-handle") && selectedLive) {
      const sz = srcSize(selectedLive);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, clipXf(selectedLive));
      const dist0 = Math.hypot(pt.x - rect.cx, pt.y - rect.cy) || 1;
      drag.current = { kind: "scale", id: selectedLive.id, scale0: clipXf(selectedLive).scale, dist0, before: snapshotClips() };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (hit) {
      useEditor.getState().select(hit.id);
      const xf = clipXf(hit);
      drag.current = { kind: "move", id: hit.id, x0: xf.x, y0: xf.y, px: pt.x, py: pt.y, before: snapshotClips() };
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
    if (d.kind === "move") {
      useEditor.getState().liveTransform(d.id, { ...xf, x: d.x0 + (pt.x - d.px), y: d.y0 + (pt.y - d.py) });
    } else if (d.kind === "scale") {
      const sz = srcSize(clip);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, xf);
      const dist = Math.hypot(pt.x - rect.cx, pt.y - rect.cy);
      useEditor.getState().liveTransform(d.id, { ...xf, scale: Math.max(0.05, Math.min(8, d.scale0 * (dist / d.dist0))) });
    } else if (d.kind === "rotate") {
      const sz = srcSize(clip);
      const rect = clipDrawRect(sz.w, sz.h, cw, ch, xf);
      const ang = Math.atan2(pt.y - rect.cy, pt.x - rect.cx);
      useEditor.getState().liveTransform(d.id, { ...xf, rotation: d.rot0 + ((ang - d.ang0) * 180) / Math.PI });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
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
        title="Wheel zoom · Alt-drag pan · click a clip to transform"
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
                <span className="bbox-rot" title="Rotate" />
                <span className="bbox-handle nw" />
                <span className="bbox-handle ne" />
                <span className="bbox-handle sw" />
                <span className="bbox-handle se" />
              </div>
            ) : null}
          </div>
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

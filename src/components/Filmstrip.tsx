import { useEffect, useMemo, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { clipDuration, type Clip } from "../core/types";
import { clipSourcePath } from "../core/project";
import { useEditor } from "../store/editorStore";

const TILE = 72;

export function Filmstrip({ clip, pps }: { clip: Clip; pps: number }) {
  const project = useEditor((s) => s.project);
  const thumbs = useEditor((s) => s.thumbsByPath);
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const path = project ? clipSourcePath(project, clip) : "";
  const dur = clipDuration(clip);
  const bag = path ? thumbs[path] : undefined;

  useEffect(() => {
    const el = canvas.current;
    const parent = wrap.current?.parentElement;
    if (!el || !parent) return;
    const draw = () => {
      const w = Math.max(1, Math.min(900, Math.floor(parent.clientWidth)));
      const h = Math.max(1, parent.clientHeight);
      if (el.width !== w) el.width = w;
      if (el.height !== h) el.height = h;
      const ctx = el.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#141a20";
      ctx.fillRect(0, 0, w, h);
      const mid = h / 2;
      ctx.fillStyle = "rgba(90, 102, 114, 0.5)";
      for (let x = 0; x < w; x += 3) {
        const amp = 4 + ((x * 13) % 11);
        ctx.fillRect(x, mid - amp, 2, amp * 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [path]);

  const tiles = useMemo(() => {
    const w = Math.max(dur * pps, 8);
    const count = Math.max(1, Math.round(w / TILE));
    const step = dur / count;
    const grid = step > 1.2 ? 1 : step > 0.45 ? 0.5 : 0.25;
    const out: { t: number; left: number; width: number; url?: string }[] = [];
    for (let i = 0; i < count; i++) {
      const src = clip.sourceStart + (i + 0.5) * step;
      const t = Math.round(src / grid) * grid;
      const key = t.toFixed(2);
      const file = bag?.[key] ?? bag?.[(Math.round(t * 4) / 4).toFixed(2)];
      out.push({
        t,
        left: i * step * pps,
        width: Math.max(2, step * pps),
        url: file ? convertFileSrc(file) : undefined,
      });
    }
    return out;
  }, [dur, pps, clip.sourceStart, bag]);

  useEffect(() => {
    if (!path || !tiles.length) return;
    const parent = wrap.current?.parentElement;
    const scroller = parent?.closest(".tl-scroll") as HTMLElement | null;
    let handle = 0;
    const kick = () => {
      window.clearTimeout(handle);
      handle = window.setTimeout(() => {
        const pr = parent?.getBoundingClientRect();
        const sr = scroller?.getBoundingClientRect();
        const times = tiles
          .filter((t) => {
            if (!pr || !sr) return true;
            const l = pr.left + t.left;
            const r = l + t.width;
            return r > sr.left - 80 && l < sr.right + 80;
          })
          .filter((t) => !t.url)
          .map((t) => t.t);
        if (times.length) useEditor.getState().ensureThumbs(path, times);
      }, 140);
    };
    kick();
    scroller?.addEventListener("scroll", kick, { passive: true });
    return () => {
      window.clearTimeout(handle);
      scroller?.removeEventListener("scroll", kick);
    };
  }, [path, tiles]);

  return (
    <div ref={wrap} className="filmstrip">
      <canvas ref={canvas} className="film-luma" />
      <div className="film-thumbs">
        {tiles.map((t) =>
          t.url ? (
            <img
              key={t.t}
              className="film-thumb"
              alt=""
              src={t.url}
              style={{ left: t.left, width: t.width }}
              draggable={false}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

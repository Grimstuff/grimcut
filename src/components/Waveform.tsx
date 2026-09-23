import { useEffect, useRef } from "react";
import { clipGainAtSource, type Clip } from "../core/types";

function dbLin(db: number) {
  return Math.min(8, Math.max(0.05, 10 ** (db / 20)));
}

function drawWave(
  canvas: HTMLCanvasElement,
  clip: Clip,
  peaks: number[],
  sourceDuration: number,
  draft: { start: number; end: number; db: number }[] | null,
) {
  const parent = canvas.parentElement;
  if (!parent) return;
  const scroller = parent.closest(".tl-scroll") as HTMLElement | null;
  const pr = parent.getBoundingClientRect();
  const sr = scroller?.getBoundingClientRect();
  const visL = sr ? Math.max(0, sr.left - pr.left) : 0;
  const visR = sr ? Math.min(pr.width, sr.right - pr.left) : pr.width;
  const visW = Math.max(1, visR - visL);
  if (visW < 2 || visR <= visL) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "block";
  canvas.style.left = `${visL}px`;
  canvas.style.width = `${visW}px`;
  const cssH = Math.max(1, parent.clientHeight || 36);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.min(2048, Math.floor(visW * dpr)));
  const h = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(180, 220, 255, 0.85)";
  const srcDur = Math.max(sourceDuration, 0.001);
  const clipDur = Math.max(0.001, clip.sourceEnd - clip.sourceStart);
  const t0 = (clip.sourceStart + (visL / Math.max(pr.width, 1)) * clipDur) / srcDur;
  const t1 = (clip.sourceStart + (visR / Math.max(pr.width, 1)) * clipDur) / srcDur;
  const n = peaks.length;
  const mid = h / 2;
  const span = Math.max(1e-6, t1 - t0);
  for (let x = 0; x < w; x++) {
    const u0 = t0 + (x / w) * span;
    const u1 = t0 + ((x + 1) / w) * span;
    let i0 = Math.floor(u0 * n);
    let i1 = Math.ceil(u1 * n);
    if (i0 < 0) i0 = 0;
    if (i1 > n) i1 = n;
    if (i1 <= i0) i1 = Math.min(n, i0 + 1);
    let peak = 0;
    for (let i = i0; i < i1; i++) {
      const a = peaks[i];
      if (a > peak) peak = a;
    }
    const src = (u0 + u1) * 0.5 * srcDur;
    let db = clipGainAtSource(clip, src);
    const t = clip.timelineStart + (src - clip.sourceStart);
    if (draft) {
      for (const d of draft) {
        if (t >= d.start && t < d.end) {
          db += d.db;
          break;
        }
      }
    }
    const amp = Math.max(0.04 * dpr, Math.min(mid - 1, peak * dbLin(db) * (mid - 1)));
    ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}

export function Waveform({
  clip,
  peaks,
  sourceDuration,
  draft,
}: {
  clip: Clip;
  peaks: number[];
  sourceDuration: number;
  draft?: { start: number; end: number; db: number }[] | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || peaks.length === 0) return;
    const parent = canvas.parentElement;
    const scroller = parent?.closest(".tl-scroll") as HTMLElement | null;
    const redraw = () => drawWave(canvas, clip, peaks, sourceDuration, draft ?? null);
    redraw();
    const ro = parent && typeof ResizeObserver !== "undefined" ? new ResizeObserver(redraw) : null;
    if (parent && ro) ro.observe(parent);
    scroller?.addEventListener("scroll", redraw, { passive: true });
    return () => {
      ro?.disconnect();
      scroller?.removeEventListener("scroll", redraw);
    };
  }, [clip.sourceStart, clip.sourceEnd, clip.timelineStart, clip.gainDb, clip.gainSpans, peaks, sourceDuration, draft]);

  if (peaks.length === 0) return null;
  return <canvas ref={ref} className="wave-canvas" />;
}

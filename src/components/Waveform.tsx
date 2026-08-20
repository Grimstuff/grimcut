import { useEffect, useRef } from "react";
import type { Clip } from "../core/types";

function drawWave(canvas: HTMLCanvasElement, clip: Clip, peaks: number[], sourceDuration: number) {
  const parent = canvas.parentElement;
  const cssW = Math.max(1, parent?.clientWidth ?? 120);
  const cssH = Math.max(1, parent?.clientHeight ?? 36);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.floor(cssW * dpr));
  const h = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(180, 220, 255, 0.85)";
  const srcDur = Math.max(sourceDuration, 0.001);
  const t0 = clip.sourceStart / srcDur;
  const t1 = clip.sourceEnd / srcDur;
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
    const amp = Math.max(0.04 * dpr, peak * (mid - 1));
    ctx.fillRect(x, mid - amp, 1, amp * 2);
  }
}

export function Waveform({ clip, peaks, sourceDuration }: { clip: Clip; peaks: number[]; sourceDuration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || peaks.length === 0) return;
    const parent = canvas.parentElement;
    const redraw = () => drawWave(canvas, clip, peaks, sourceDuration);
    redraw();
    if (!parent || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(redraw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [clip.sourceStart, clip.sourceEnd, clip.timelineStart, peaks, sourceDuration]);

  if (peaks.length === 0) return null;
  return <canvas ref={ref} className="wave-canvas" />;
}

import { useEffect, useRef } from "react";
import { clipDuration } from "../core/types";
import type { Clip } from "../core/types";

export function Waveform({ clip, peaks, sourceDuration }: { clip: Clip; peaks: number[]; sourceDuration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || peaks.length === 0) return;
    const parent = canvas.parentElement;
    const w = parent?.clientWidth ?? 120;
    const h = parent?.clientHeight ?? 36;
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(180, 220, 255, 0.85)";
    const dur = clipDuration(clip);
    const t0 = clip.sourceStart / Math.max(sourceDuration, 0.001);
    const t1 = clip.sourceEnd / Math.max(sourceDuration, 0.001);
    const i0 = Math.floor(t0 * peaks.length);
    const i1 = Math.max(i0 + 1, Math.ceil(t1 * peaks.length));
    const slice = peaks.slice(i0, i1);
    const mid = h / 2;
    const n = slice.length;
    for (let i = 0; i < n; i++) {
      const x = (i / n) * w;
      const amp = Math.max(0.04, slice[i]) * (mid - 1);
      ctx.fillRect(x, mid - amp, Math.max(1, w / n), amp * 2);
    }
    void dur;
  }, [clip, peaks, sourceDuration]);

  if (peaks.length === 0) return null;
  return <canvas ref={ref} className="wave-canvas" />;
}

import type { Clip } from "./types";

export type ClipTransform = {
  x: number;
  y: number;
  scale: number;
  rotation: number;
};

export const AR_PRESETS: { id: string; w: number; h: number }[] = [
  { id: "16:9", w: 1920, h: 1080 },
  { id: "9:16", w: 1080, h: 1920 },
  { id: "1:1", w: 1080, h: 1080 },
  { id: "4:3", w: 1440, h: 1080 },
];

export const RES_BY_AR: Record<string, { w: number; h: number; label: string }[]> = {
  "16:9": [
    { w: 3840, h: 2160, label: "3840 × 2160" },
    { w: 2560, h: 1440, label: "2560 × 1440" },
    { w: 1920, h: 1080, label: "1920 × 1080" },
    { w: 1280, h: 720, label: "1280 × 720" },
    { w: 854, h: 480, label: "854 × 480" },
  ],
  "9:16": [
    { w: 2160, h: 3840, label: "2160 × 3840" },
    { w: 1440, h: 2560, label: "1440 × 2560" },
    { w: 1080, h: 1920, label: "1080 × 1920" },
    { w: 720, h: 1280, label: "720 × 1280" },
    { w: 480, h: 854, label: "480 × 854" },
  ],
  "1:1": [
    { w: 2160, h: 2160, label: "2160 × 2160" },
    { w: 1440, h: 1440, label: "1440 × 1440" },
    { w: 1080, h: 1080, label: "1080 × 1080" },
    { w: 720, h: 720, label: "720 × 720" },
  ],
  "4:3": [
    { w: 2048, h: 1536, label: "2048 × 1536" },
    { w: 1600, h: 1200, label: "1600 × 1200" },
    { w: 1440, h: 1080, label: "1440 × 1080" },
    { w: 1024, h: 768, label: "1024 × 768" },
    { w: 640, h: 480, label: "640 × 480" },
  ],
};

export function arOf(w: number, h: number): string {
  const r = w / Math.max(1, h);
  let best = AR_PRESETS[0].id;
  let bestD = Infinity;
  for (const p of AR_PRESETS) {
    const d = Math.abs(r - p.w / p.h);
    if (d < bestD) {
      bestD = d;
      best = p.id;
    }
  }
  return best;
}

export function defaultTransform(): ClipTransform {
  return { x: 0, y: 0, scale: 1, rotation: 0 };
}

export function evenPx(n: number, fallback = 2): number {
  const v = Number.isFinite(n) && n > 1 ? Math.round(n) : fallback;
  return Math.max(2, v - (v % 2));
}

export function clipXf(c: Clip): ClipTransform {
  return c.transform ? { ...c.transform } : defaultTransform();
}

/** Native pixels of the clip, scaled so the whole frame fits the canvas at scale=1. */
export function containSize(srcW: number, srcH: number, canvasW: number, canvasH: number, scale: number) {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const fit = Math.min(canvasW / sw, canvasH / sh);
  const s = fit * Math.max(0.02, scale);
  return { w: sw * s, h: sh * s };
}

export function clipDrawRect(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  xf: ClipTransform,
) {
  const { w, h } = containSize(srcW, srcH, canvasW, canvasH, xf.scale);
  const cx = canvasW / 2 + xf.x;
  const cy = canvasH / 2 + xf.y;
  return { w, h, x: cx - w / 2, y: cy - h / 2, cx, cy, rotation: xf.rotation };
}

export function pointInRotatedRect(
  px: number,
  py: number,
  rect: { x: number; y: number; w: number; h: number; rotation: number },
) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const rad = (-rect.rotation * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= rect.w / 2 && Math.abs(ly) <= rect.h / 2;
}

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
  { id: "4:5", w: 1080, h: 1350 },
  { id: "4:3", w: 1440, h: 1080 },
  { id: "21:9", w: 2560, h: 1080 },
];

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

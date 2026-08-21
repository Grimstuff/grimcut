import type { Clip } from "./types";

export type ClipTransform = {
  x: number;
  y: number;
  scale: number;
  /** Extra stretch; default = `scale` (uniform). */
  scaleX?: number;
  scaleY?: number;
  rotation: number;
};

export const AR_PRESETS: { id: string; w: number; h: number }[] = [
  { id: "16:9", w: 1920, h: 1080 },
  { id: "9:16", w: 1080, h: 1920 },
  { id: "1:1", w: 1080, h: 1080 },
  { id: "4:3", w: 1440, h: 1080 },
];

function ytLabel(w: number, h: number) {
  const short = Math.min(w, h);
  const tag =
    short >= 2160
      ? "4K"
      : short >= 1440
        ? "1440p"
        : short >= 1080
          ? "1080p"
          : short >= 720
            ? "720p"
            : short >= 480
              ? "480p"
              : short >= 360
                ? "360p"
                : short >= 240
                  ? "240p"
                  : short >= 144
                    ? "144p"
                    : null;
  return tag ? `${tag}  ·  ${w} × ${h}` : `${w} × ${h}`;
}

function res(w: number, h: number) {
  return { w, h, label: ytLabel(w, h) };
}

export const RES_BY_AR: Record<string, { w: number; h: number; label: string }[]> = {
  "16:9": [
    res(3840, 2160),
    res(2560, 1440),
    res(1920, 1080),
    res(1280, 720),
    res(854, 480),
    res(640, 360),
    res(426, 240),
    res(256, 144),
  ],
  "9:16": [
    res(2160, 3840),
    res(1440, 2560),
    res(1080, 1920),
    res(720, 1280),
    res(480, 854),
    res(360, 640),
    res(240, 426),
    res(144, 256),
  ],
  "1:1": [
    res(2160, 2160),
    res(1440, 1440),
    res(1080, 1080),
    res(720, 720),
    res(480, 480),
    res(360, 360),
    res(240, 240),
    res(144, 144),
  ],
  "4:3": [
    res(1920, 1440),
    res(1440, 1080),
    res(960, 720),
    res(640, 480),
    res(480, 360),
    res(320, 240),
    res(192, 144),
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
  return { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };
}

export function xfScaleX(xf: ClipTransform) {
  return xf.scaleX ?? xf.scale;
}

export function xfScaleY(xf: ClipTransform) {
  return xf.scaleY ?? xf.scale;
}

export function evenPx(n: number, fallback = 2): number {
  const v = Number.isFinite(n) && n > 1 ? Math.round(n) : fallback;
  return Math.max(2, v - (v % 2));
}

export function clipXf(c: Clip): ClipTransform {
  return c.transform ? { ...c.transform } : defaultTransform();
}

/** Native pixels of the clip, scaled so the whole frame fits the canvas at scale=1. */
export function containSize(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  scaleX: number,
  scaleY = scaleX,
) {
  const sw = Math.max(1, srcW);
  const sh = Math.max(1, srcH);
  const fit = Math.min(canvasW / sw, canvasH / sh);
  return { w: sw * fit * Math.max(0.02, scaleX), h: sh * fit * Math.max(0.02, scaleY), fit };
}

export function clipDrawRect(
  srcW: number,
  srcH: number,
  canvasW: number,
  canvasH: number,
  xf: ClipTransform,
  mode: "video" | "text" = "video",
) {
  const sx = xfScaleX(xf);
  const sy = xfScaleY(xf);
  const { w, h } =
    mode === "text"
      ? { w: Math.max(8, srcW * sx), h: Math.max(8, srcH * sy) }
      : containSize(srcW, srcH, canvasW, canvasH, sx, sy);
  const cx = canvasW / 2 + xf.x;
  const cy = canvasH / 2 + xf.y;
  return { w, h, x: cx - w / 2, y: cy - h / 2, cx, cy, rotation: xf.rotation };
}

export function canvasGuides(cw: number, ch: number) {
  return {
    xs: [cw / 3, cw / 2, (2 * cw) / 3],
    ys: [ch / 3, ch / 2, (2 * ch) / 3],
  };
}

/** Visible thirds × center dots. */
export function canvasSnapPoints(cw: number, ch: number): { x: number; y: number }[] {
  const { xs, ys } = canvasGuides(cw, ch);
  const pts: { x: number; y: number }[] = [];
  for (const x of xs) for (const y of ys) pts.push({ x, y });
  return pts;
}

/** Magnets: frame corners + edge mids + thirds/center. */
export function canvasMagnetPoints(cw: number, ch: number): { x: number; y: number }[] {
  const xs = [0, cw / 3, cw / 2, (2 * cw) / 3, cw];
  const ys = [0, ch / 3, ch / 2, (2 * ch) / 3, ch];
  const pts: { x: number; y: number }[] = [];
  for (const x of xs) for (const y of ys) pts.push({ x, y });
  return pts;
}

export function nearestPoint(
  px: number,
  py: number,
  pts: { x: number; y: number }[],
  thresh: number,
): { x: number; y: number; dist: number } | null {
  let best: { x: number; y: number } | null = null;
  let d = thresh;
  for (const p of pts) {
    const dd = Math.hypot(px - p.x, py - p.y);
    if (dd <= d) {
      d = dd;
      best = p;
    }
  }
  return best ? { x: best.x, y: best.y, dist: d } : null;
}

export function snapRotation(deg: number, thresh = 5): number {
  const targets = [0, 45, 90, 135, 180, -45, -90, -135, -180, 225, 270, 315, 360, -225, -270];
  let n = deg;
  while (n > 180) n -= 360;
  while (n < -180) n += 360;
  for (const t of targets) {
    if (Math.abs(n - t) <= thresh) return t === 360 || t === -360 ? 0 : t;
  }
  return n;
}

/** Word / Photoshop-style type sizes. */
export const FONT_SIZE_STEPS = [
  6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 60, 72, 84, 96, 120, 144, 192, 216, 240, 288, 300,
];

export function stepFontSize(current: number, dir: 1 | -1): number {
  const n = Math.max(6, Math.min(400, Number.isFinite(current) ? current : 64));
  if (dir > 0) {
    const next = FONT_SIZE_STEPS.find((s) => s > n + 0.05);
    return next ?? FONT_SIZE_STEPS[FONT_SIZE_STEPS.length - 1];
  }
  let prev = FONT_SIZE_STEPS[0];
  for (const s of FONT_SIZE_STEPS) {
    if (s < n - 0.05) prev = s;
  }
  return prev;
}

export function visualFontSize(c: Clip): number {
  return Math.max(6, Math.round((c.fontSize ?? 64) * xfScaleY(clipXf(c))));
}

export function contrastInk(hex: string): string {
  const t = hex.trim().replace(/^#/, "");
  const s = t.length === 3 ? t[0] + t[0] + t[1] + t[1] + t[2] + t[2] : t;
  if (!/^[0-9a-f]{6}$/i.test(s)) return "#000000";
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 140 ? "#000000" : "#ffffff";
}

export function measureTextBox(c: Pick<Clip, "text" | "fontFamily" | "fontSize" | "textAlign" | "transform">): {
  w: number;
  h: number;
} {
  if (typeof document === "undefined") return { w: 280, h: 88 };
  const size = visualFontSize(c as Clip);
  const host = document.createElement("div");
  host.style.cssText = [
    "position:absolute",
    "left:-9999px",
    "top:0",
    "visibility:hidden",
    "pointer-events:none",
    "width:max-content",
    "max-width:none",
    "white-space:pre",
    "line-height:1.15",
    "padding:4px 10px",
    `font-family:${JSON.stringify(c.fontFamily ?? "Segoe UI")}`,
    `font-size:${size}px`,
    `text-align:${c.textAlign ?? "center"}`,
  ].join(";");
  host.textContent = (c.text ?? "").length ? (c.text as string) : "Text";
  document.body.appendChild(host);
  const w = Math.ceil(Math.max(24, host.offsetWidth + 8));
  const h = Math.ceil(Math.max(24, host.offsetHeight + 4));
  host.remove();
  return { w, h };
}

export function bakeTextScale(c: Clip): Clip {
  const xf = clipXf(c);
  const sx = xfScaleX(xf);
  const sy = xfScaleY(xf);
  return {
    ...c,
    fontSize: visualFontSize(c),
    boxW: Math.max(8, (c.boxW || 280) * sx),
    boxH: Math.max(8, (c.boxH || 88) * sy),
    transform: { ...xf, scale: 1, scaleX: 1, scaleY: 1 },
  };
}

export function hugTextClip(c: Clip): Clip {
  const xf = clipXf(c);
  const next: Clip = {
    ...c,
    fontSize: visualFontSize(c),
    transform: { ...xf, scale: 1, scaleX: 1, scaleY: 1 },
  };
  const box = measureTextBox(next);
  return { ...next, boxW: box.w, boxH: box.h };
}

export function textLayoutFromRect(
  left: number,
  top: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
  rotation: number,
  fontSize: number,
): Pick<Clip, "transform" | "boxW" | "boxH" | "fontSize"> {
  return {
    transform: {
      x: left + w / 2 - canvasW / 2,
      y: top + h / 2 - canvasH / 2,
      scale: 1,
      scaleX: 1,
      scaleY: 1,
      rotation,
    },
    boxW: Math.max(8, w),
    boxH: Math.max(8, h),
    fontSize: Math.max(6, Math.min(400, fontSize)),
  };
}

export function rectToTransform(
  left: number,
  top: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
  srcW: number,
  srcH: number,
  rotation: number,
): ClipTransform {
  const { fit } = containSize(srcW, srcH, canvasW, canvasH, 1, 1);
  const scaleX = w / (srcW * fit);
  const scaleY = h / (srcH * fit);
  return {
    x: left + w / 2 - canvasW / 2,
    y: top + h / 2 - canvasH / 2,
    scale: (scaleX + scaleY) / 2,
    scaleX,
    scaleY,
    rotation,
  };
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

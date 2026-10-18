import { clipDuration, newId, type AnimKey, type Clip } from "./types";

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

function lerpN(a: number, b: number, u: number) {
  return a + (b - a) * u;
}

function lerpAngle(a: number, b: number, u: number) {
  let d = b - a;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return a + d * u;
}

function poseNear(a: ClipTransform, b: ClipTransform) {
  let d = a.rotation - b.rotation;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return (
    Math.hypot(a.x - b.x, a.y - b.y) < 0.8 &&
    Math.abs(xfScaleX(a) - xfScaleX(b)) < 0.012 &&
    Math.abs(xfScaleY(a) - xfScaleY(b)) < 0.012 &&
    Math.abs(d) < 0.6
  );
}

export function animOn(k: AnimKey, ch: "pan" | "rotate" | "scale" | "blend") {
  return k.channels?.[ch] !== false;
}

/** A canvas drag names which parts it is allowed to change. The rest stay put. */
export function writeTransform(
  prev: ClipTransform,
  next: ClipTransform,
  write?: { pan?: boolean; rotate?: boolean; scale?: boolean },
): ClipTransform {
  if (!write) return { ...next, scaleX: next.scaleX ?? next.scale, scaleY: next.scaleY ?? next.scale };
  return {
    x: write.pan ? next.x : prev.x,
    y: write.pan ? next.y : prev.y,
    rotation: write.rotate ? next.rotation : prev.rotation,
    scale: write.scale ? next.scale : prev.scale,
    scaleX: write.scale ? (next.scaleX ?? next.scale) : (prev.scaleX ?? prev.scale),
    scaleY: write.scale ? (next.scaleY ?? next.scale) : (prev.scaleY ?? prev.scale),
  };
}

/** Keep channels the key has switched off when a canvas drag writes a new pose. */
export function maskAnimWrite(prev: AnimKey | undefined, next: AnimKey): AnimKey {
  if (!prev?.channels) return next;
  const pan = animOn(prev, "pan");
  const rotate = animOn(prev, "rotate");
  const scale = animOn(prev, "scale");
  return {
    ...next,
    x: pan ? next.x : prev.x,
    y: pan ? next.y : prev.y,
    rotation: rotate ? next.rotation : prev.rotation,
    scale: scale ? next.scale : prev.scale,
    scaleX: scale ? next.scaleX : prev.scaleX,
    scaleY: scale ? next.scaleY : prev.scaleY,
    channels: { ...prev.channels },
  };
}

function channelValue<T>(
  keys: AnimKey[],
  t: number,
  owns: (k: AnimKey) => boolean,
  read: (k: AnimKey) => T,
  lerp: (a: T, b: T, u: number) => T,
  fallback: T,
): T {
  const owned = keys.filter(owns);
  if (!owned.length) return fallback;
  if (t <= owned[0].t) return read(owned[0]);
  const last = owned[owned.length - 1];
  if (t >= last.t) return read(last);
  for (let i = 0; i < owned.length - 1; i++) {
    const a = owned[i];
    const b = owned[i + 1];
    if (t < a.t || t > b.t) continue;
    if (!animOn(b, "blend")) return read(a);
    const u = (t - a.t) / Math.max(0.0001, b.t - a.t);
    return lerp(read(a), read(b), u);
  }
  return read(last);
}

/** Pose at a timeline time. Keys are offsets from the clip start. A channel that is off is ignored. */
export function poseAt(c: Clip, timelineT: number): ClipTransform {
  const keys = [...(c.anim ?? [])].sort((a, b) => a.t - b.t);
  if (!keys.length) return clipXf(c);
  const t = timelineT - c.timelineStart;
  const rest = clipXf(c);
  const pos = channelValue(
    keys,
    t,
    (k) => animOn(k, "pan"),
    (k) => ({ x: k.x, y: k.y }),
    (a, b, u) => ({ x: lerpN(a.x, b.x, u), y: lerpN(a.y, b.y, u) }),
    { x: rest.x, y: rest.y },
  );
  const scl = channelValue(
    keys,
    t,
    (k) => animOn(k, "scale"),
    (k) => ({ scale: k.scale, scaleX: k.scaleX, scaleY: k.scaleY }),
    (a, b, u) => ({
      scale: lerpN(a.scale, b.scale, u),
      scaleX: lerpN(a.scaleX, b.scaleX, u),
      scaleY: lerpN(a.scaleY, b.scaleY, u),
    }),
    { scale: rest.scale, scaleX: rest.scaleX ?? rest.scale, scaleY: rest.scaleY ?? rest.scale },
  );
  const rotation = channelValue(
    keys,
    t,
    (k) => animOn(k, "rotate"),
    (k) => k.rotation,
    lerpAngle,
    rest.rotation,
  );
  return { x: pos.x, y: pos.y, scale: scl.scale, scaleX: scl.scaleX, scaleY: scl.scaleY, rotation };
}

/** Keys that survive a trim or slice, shifted so local 0 is `localFrom`. Samples the cut so the pose doesn't jump. */
export function animRetimed(clip: Clip, localFrom: number, localTo: number): AnimKey[] | undefined {
  const src = clip.anim;
  if (!src?.length) return undefined;
  const span = localTo - localFrom;
  if (!(span > 0.02)) return undefined;
  const sample = (local: number, t: number): AnimKey => {
    const xf = poseAt(clip, clip.timelineStart + local);
    return {
      id: newId(),
      t,
      x: xf.x,
      y: xf.y,
      scale: xf.scale,
      scaleX: xf.scaleX ?? xf.scale,
      scaleY: xf.scaleY ?? xf.scale,
      rotation: xf.rotation,
    };
  };
  const kept = src
    .filter((k) => k.t >= localFrom - 1e-3 && k.t <= localTo + 1e-3)
    .map((k) => ({ ...k, t: Math.max(0, Math.min(span, k.t - localFrom)) }))
    .sort((a, b) => a.t - b.t);
  const want0 = poseAt(clip, clip.timelineStart + localFrom);
  const want1 = poseAt(clip, clip.timelineStart + localTo);
  const out: AnimKey[] = [];
  const ghost: Clip = { ...clip, timelineStart: 0, anim: kept };
  if (!kept.length || !poseNear(poseAt(ghost, 0), want0)) out.push(sample(localFrom, 0));
  for (const k of kept) {
    if (out.some((e) => Math.abs(e.t - k.t) < 0.03)) continue;
    out.push(k);
  }
  const withKept: Clip = { ...clip, timelineStart: 0, anim: out };
  if (!poseNear(poseAt(withKept, span), want1)) out.push(sample(localTo, span));
  out.sort((a, b) => a.t - b.t);
  return out.length ? out : undefined;
}

/**
 * Clip the motion key button acts on at the playhead: the selected video/text clip,
 * else the overlay (2nd layer, it sits on top), else the main track.
 */
export function motionTarget(clips: Clip[], playhead: number, selectedId: string | null): Clip | null {
  const hit = clips.filter(
    (c) =>
      c.kind !== "audio" &&
      playhead >= c.timelineStart - 0.001 &&
      playhead <= c.timelineStart + clipDuration(c) + 0.001,
  );
  return hit.find((c) => c.id === selectedId) ?? hit.find((c) => c.layer === "over") ?? hit[0] ?? null;
}

/** Previous / next key on a clip from a timeline time. Keys within 30 ms of `timelineT` are skipped. */
export function stepKey(c: Clip, timelineT: number, dir: 1 | -1): AnimKey | null {
  const local = timelineT - c.timelineStart;
  const keys = [...(c.anim ?? [])].sort((a, b) => a.t - b.t);
  if (dir > 0) return keys.find((k) => k.t > local + 0.03) ?? null;
  return [...keys].reverse().find((k) => k.t < local - 0.03) ?? null;
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

/** One knob for every clip-on-canvas snap (move, scale, cover). Canvas pixels at zoom 1. */
export const CANVAS_SNAP = 14;

export function canvasSnapThresh(viewZoom: number) {
  return CANVAS_SNAP / Math.max(0.2, viewZoom);
}

export function canvasEdgeLines(cw: number, ch: number) {
  return {
    xs: [0, cw / 3, cw / 2, (2 * cw) / 3, cw],
    ys: [0, ch / 3, ch / 2, (2 * ch) / 3, ch],
  };
}

/** Snap a moving rect’s edges independently (top→canvas top, not only corners). */
export function snapRectMove(
  left: number,
  top: number,
  w: number,
  h: number,
  cw: number,
  ch: number,
  thresh: number,
): { left: number; top: number; hot: { x: number; y: number } | null } {
  const { xs, ys } = canvasEdgeLines(cw, ch);
  const xEdges = [left, left + w / 2, left + w];
  const yEdges = [top, top + h / 2, top + h];
  let dx = 0;
  let dy = 0;
  let bestX = thresh + 1;
  let bestY = thresh + 1;
  let hx: number | null = null;
  let hy: number | null = null;
  for (const e of xEdges) {
    for (const t of xs) {
      const d = Math.abs(e - t);
      if (d < bestX) {
        bestX = d;
        dx = t - e;
        hx = t;
      }
    }
  }
  for (const e of yEdges) {
    for (const t of ys) {
      const d = Math.abs(e - t);
      if (d < bestY) {
        bestY = d;
        dy = t - e;
        hy = t;
      }
    }
  }
  const nl = bestX <= thresh ? left + dx : left;
  const nt = bestY <= thresh ? top + dy : top;
  let hot: { x: number; y: number } | null = null;
  if (hx != null && bestX <= thresh && hy != null && bestY <= thresh) hot = { x: hx, y: hy };
  else if (hx != null && bestX <= thresh) hot = { x: hx, y: nt + h / 2 };
  else if (hy != null && bestY <= thresh) hot = { x: nl + w / 2, y: hy };
  return { left: nl, top: nt, hot };
}

/** Snap a scale rect so bbox edges catch the canvas frame (contain / cover). */
export function snapScaleToCanvas(
  left: number,
  top: number,
  w: number,
  h: number,
  cw: number,
  ch: number,
  thresh: number,
  opts: {
    fromCenter: boolean;
    cx0: number;
    cy0: number;
    ax: number;
    ay: number;
    free: boolean;
    ar: number;
  },
): { left: number; top: number; w: number; h: number; hot: { x: number; y: number } | null } {
  const ar = Math.max(0.01, opts.ar);
  const pinL = !opts.fromCenter && Math.abs(left - opts.ax) < 0.75;
  const pinT = !opts.fromCenter && Math.abs(top - opts.ay) < 0.75;
  const pinR = !opts.fromCenter && Math.abs(left + w - opts.ax) < 0.75;
  const pinB = !opts.fromCenter && Math.abs(top + h - opts.ay) < 0.75;

  type Cand = { score: number; w: number; h: number; hot: { x: number; y: number } };
  const cands: Cand[] = [];

  const pushW = (nw: number, dist: number, hx: number) => {
    if (!Number.isFinite(nw) || nw < 4 || dist > thresh) return;
    const nh = opts.free ? h : nw / ar;
    cands.push({ score: dist, w: Math.max(4, nw), h: Math.max(4, nh), hot: { x: hx, y: opts.fromCenter ? opts.cy0 : top + h / 2 } });
  };
  const pushH = (nh: number, dist: number, hy: number) => {
    if (!Number.isFinite(nh) || nh < 4 || dist > thresh) return;
    const nw = opts.free ? w : nh * ar;
    cands.push({ score: dist, w: Math.max(4, nw), h: Math.max(4, nh), hot: { x: opts.fromCenter ? opts.cx0 : left + w / 2, y: hy } });
  };

  if (opts.fromCenter) {
    pushW(opts.cx0 * 2, Math.abs(left - 0), 0);
    pushW((cw - opts.cx0) * 2, Math.abs(left + w - cw), cw);
    pushH(opts.cy0 * 2, Math.abs(top - 0), 0);
    pushH((ch - opts.cy0) * 2, Math.abs(top + h - ch), ch);
  } else {
    if (!pinL) pushW(opts.ax - 0, Math.abs(left - 0), 0);
    if (!pinR) pushW(cw - opts.ax, Math.abs(left + w - cw), cw);
    if (!pinT) pushH(opts.ay - 0, Math.abs(top - 0), 0);
    if (!pinB) pushH(ch - opts.ay, Math.abs(top + h - ch), ch);
  }

  if (cands.length === 0) return { left, top, w, h, hot: null };
  cands.sort((a, b) => a.score - b.score);
  const best = cands[0];
  let nl: number;
  let nt: number;
  if (opts.fromCenter) {
    nl = opts.cx0 - best.w / 2;
    nt = opts.cy0 - best.h / 2;
  } else {
    nl = pinL ? opts.ax : pinR ? opts.ax - best.w : left;
    nt = pinT ? opts.ay : pinB ? opts.ay - best.h : top;
  }
  return { left: nl, top: nt, w: best.w, h: best.h, hot: best.hot };
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

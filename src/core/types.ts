import type { ClipTransform } from "./canvas";

export type { ClipTransform };

export type ClipKind = "video" | "audio" | "text";
export type TextAlign = "left" | "center" | "right";
export type ClipEffectKind = "blur";

export type ClipEffect = {
  id: string;
  kind: ClipEffectKind;
  /** Blur radius in px (preview CSS / ffmpeg sigma). */
  amount: number;
};

/** What a motion key owns. Omitted or true = on. */
export type AnimChannels = {
  pan?: boolean;
  rotate?: boolean;
  scale?: boolean;
  /** false = hold the previous pose, then jump when this key is reached. */
  blend?: boolean;
};

/** Motion key on a clip. Time is seconds from the clip's timeline start — not a GOP keyframe. */
export type AnimKey = {
  id: string;
  t: number;
  x: number;
  y: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  channels?: AnimChannels;
};
/** Two-layer system: `base` is the main track, `over` is the single 2nd layer per kind. Overlay wins while it covers. */
export type ClipLayer = "base" | "over";

export type Clip = {
  id: string;
  kind: ClipKind;
  layer: ClipLayer;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
  /** Shared id with the paired A/V clip; null = unlinked. */
  linkGroup: string | null;
  /** Other file than the project source (overlay from a drop). */
  sourcePath?: string;
  /** Canvas placement. scale=1 fits the whole frame in the canvas. */
  transform?: ClipTransform;
  text?: string;
  fontFamily?: string;
  fontSize?: number;
  textAlign?: TextAlign;
  textColor?: string;
  textShadow?: boolean;
  textStroke?: boolean;
  boxW?: number;
  boxH?: number;
  effects?: ClipEffect[];
  /** Extra loudness in dB for the whole clip (0 = original). */
  gainDb?: number;
  /** Extra loudness on source-time ranges; does not split the clip. */
  gainSpans?: { sourceStart: number; sourceEnd: number; db: number }[];
  /** Position / scale / rotation over time. Empty = static transform. */
  anim?: AnimKey[];
};

export type VideoProject = {
  sourcePath: string;
  sourceDuration: number;
  canvasWidth: number;
  canvasHeight: number;
  clips: Clip[];
};

export type SubtitleTrack = {
  index: number;
  codec: string;
  language?: string | null;
  title?: string | null;
  text: boolean;
  sidecar?: string | null;
};

export type MediaInfo = {
  path: string;
  duration: number;
  container?: string | null;
  videoCodec?: string | null;
  width?: number | null;
  height?: number | null;
  audioCodec?: string | null;
  frameRate?: number | null;
  hasAudio: boolean;
  keyframeTimes: number[];
  subtitles?: SubtitleTrack[];
};

export function textSubtitleTracks(m: MediaInfo | null | undefined): SubtitleTrack[] {
  return (m?.subtitles ?? []).filter((s) => s.text);
}

export type SubCue = { start: number; end: number; text: string };

export function cueAt(cues: SubCue[], t: number): SubCue | null {
  let best: SubCue | null = null;
  for (const c of cues) {
    if (t >= c.start && t < c.end && (!best || c.start >= best.start)) best = c;
  }
  return best;
}

export type SubStyle = {
  fontFamily: string;
  color: string;
  fontSize: number;
  shadow: boolean;
  stroke: boolean;
};

export const DEFAULT_SUB_STYLE: SubStyle = {
  fontFamily: "Arial",
  color: "#ffffff",
  fontSize: 48,
  shadow: true,
  stroke: true,
};

export const SUBTITLE_FONTS = [
  "Arial",
  "Tahoma",
  "Verdana",
  "Trebuchet MS",
  "Segoe UI",
  "Calibri",
  "Georgia",
  "Times New Roman",
  "Impact",
];

/** White, pale cinema yellow, cyan, green, black — typical burned-in palettes. */
export const SUBTITLE_SWATCHES = ["#ffffff", "#f3e39a", "#7ee8ff", "#9dffb0", "#000000"];

export const SUB_PICK_ID = "subs";

export type TimeRange = { start: number; end: number };

/** Timeline selection on a clip (seconds). */
export type ClipSpan = { clipId: string; start: number; end: number };

export type ClipboardChunk = {
  kind: ClipKind;
  sourceStart: number;
  sourceEnd: number;
  sourcePath?: string;
  /** True for Cut: paste once, then clear. Copy stays until replaced. */
  consume?: boolean;
};

export type PlaybackKind = "continue" | "jump" | "gap" | "stop";

export type PlaybackFollow = {
  kind: PlaybackKind;
  timeline: number;
  seekSource?: number;
  segmentId?: string;
  gapEnd?: number;
};

export const MIN_CLIP = 0.05;
export const SNAP = 0.08;

export function clipGainAtSource(c: Clip, src: number): number {
  let db = c.gainDb ?? 0;
  for (const g of c.gainSpans ?? []) {
    if (src >= g.sourceStart && src < g.sourceEnd) db += g.db;
  }
  return db;
}

export function addGainRegion(
  spans: Clip["gainSpans"],
  a: number,
  b: number,
  db: number,
): NonNullable<Clip["gainSpans"]> {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (hi - lo < 0.01 || Math.abs(db) < 0.05) return [...(spans ?? [])];
  const cuts = [lo, hi];
  for (const s of spans ?? []) {
    cuts.push(s.sourceStart, s.sourceEnd);
  }
  const pts = [...new Set(cuts.map((n) => Math.round(n * 1000) / 1000))].sort((x, y) => x - y);
  const out: NonNullable<Clip["gainSpans"]> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i];
    const e = pts[i + 1];
    if (e - s < 0.01) continue;
    const mid = (s + e) / 2;
    let g = 0;
    for (const old of spans ?? []) {
      if (mid >= old.sourceStart && mid < old.sourceEnd) g += old.db;
    }
    if (mid >= lo && mid < hi) g += db;
    if (Math.abs(g) < 0.05) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last.db - g) < 0.05 && Math.abs(last.sourceEnd - s) < 0.02) last.sourceEnd = e;
    else out.push({ sourceStart: s, sourceEnd: e, db: g });
  }
  return out;
}

export function clipDuration(s: Clip): number {
  return Math.max(0, s.sourceEnd - s.sourceStart);
}

export function clipEnd(s: Clip): number {
  return s.timelineStart + clipDuration(s);
}

export function cloneClip(s: Clip): Clip {
  return {
    ...s,
    transform: s.transform ? { ...s.transform } : undefined,
    effects: s.effects?.map((e) => ({ ...e })),
    gainSpans: s.gainSpans?.map((g) => ({ ...g })),
    anim: s.anim?.map((k) => ({ ...k })),
  };
}

export function clipEffects(c: Clip): ClipEffect[] {
  return c.effects ?? [];
}

export function clipBlur(c: Clip): number {
  return clipEffects(c)
    .filter((e) => e.kind === "blur")
    .reduce((s, e) => s + e.amount, 0);
}



export function newId(): string {
  return crypto.randomUUID();
}

export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

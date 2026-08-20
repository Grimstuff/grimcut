import type { ClipTransform } from "./canvas";

export type { ClipTransform };

export type ClipKind = "video" | "audio";
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
};

export type VideoProject = {
  sourcePath: string;
  sourceDuration: number;
  canvasWidth: number;
  canvasHeight: number;
  clips: Clip[];
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
};

export type TimeRange = { start: number; end: number };

export type ClipboardChunk = {
  kind: ClipKind;
  sourceStart: number;
  sourceEnd: number;
  sourcePath?: string;
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

export function clipDuration(s: Clip): number {
  return Math.max(0, s.sourceEnd - s.sourceStart);
}

export function clipEnd(s: Clip): number {
  return s.timelineStart + clipDuration(s);
}

export function cloneClip(s: Clip): Clip {
  return { ...s, transform: s.transform ? { ...s.transform } : undefined };
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

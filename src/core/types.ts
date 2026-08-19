export type ClipSegment = {
  id: string;
  timelineStart: number;
  sourceStart: number;
  sourceEnd: number;
};

export type VideoProject = {
  sourcePath: string;
  sourceDuration: number;
  segments: ClipSegment[];
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

export type PlaybackKind = "continue" | "jump" | "gap" | "stop";

export type PlaybackFollow = {
  kind: PlaybackKind;
  timeline: number;
  seekSource?: number;
  segmentId?: string;
  gapEnd?: number;
};

export const MIN_CLIP = 0.05;

export function clipDuration(s: ClipSegment): number {
  return Math.max(0, s.sourceEnd - s.sourceStart);
}

export function clipTimelineEnd(s: ClipSegment): number {
  return s.timelineStart + clipDuration(s);
}

export function cloneClip(s: ClipSegment): ClipSegment {
  return { ...s };
}

export function newId(): string {
  return crypto.randomUUID();
}

export function formatTime(t: number): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const body = `${m}:${s.toFixed(2).padStart(5, "0")}`;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}` : body;
}

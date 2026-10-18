import { evenPx, poseAt, xfScaleX, xfScaleY, type ClipTransform } from "./canvas";
import {
  type Clip,
  type ClipKind,
  type ClipLayer,
  type MediaInfo,
  type PlaybackFollow,
  type VideoProject,
  clipBlur,
  clipDuration,
  clipGainAtSource,
  clipEnd,
  cloneClip,
  newId,
  SNAP,
} from "./types";

export function fromMedia(info: MediaInfo): VideoProject {
  const duration = info.duration > 0 ? info.duration : 1;
  const group = newId();
  const clips: Clip[] = [
    {
      id: newId(),
      kind: "video",
      layer: "base",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: duration,
      linkGroup: group,
      transform: { x: 0, y: 0, scale: 1, rotation: 0 },
    },
  ];
  if (info.hasAudio) {
    clips.push({
      id: newId(),
      kind: "audio",
      layer: "base",
      timelineStart: 0,
      sourceStart: 0,
      sourceEnd: duration,
      linkGroup: group,
    });
  }
  return {
    sourcePath: info.path,
    sourceDuration: info.duration,
    canvasWidth: evenPx(info.width ?? 1920, 1920),
    canvasHeight: evenPx(info.height ?? 1080, 1080),
    clips,
  };
}

export function timelineDuration(p: VideoProject): number {
  return p.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

export function rulerDuration(p: VideoProject): number {
  return Math.max(p.sourceDuration, timelineDuration(p), 1);
}

export function clipsOn(p: VideoProject, kind: ClipKind, layer?: ClipLayer): Clip[] {
  return p.clips
    .filter((c) => c.kind === kind && (layer ? c.layer === layer : true))
    .sort((a, b) => a.timelineStart - b.timelineStart);
}

export function clipAt(
  p: VideoProject,
  t: number,
  kind: ClipKind,
  layer?: ClipLayer,
): Clip | null {
  if (!layer) {
    for (let i = p.clips.length - 1; i >= 0; i--) {
      const c = p.clips[i];
      if (c.kind === kind && c.layer === "over" && t >= c.timelineStart && t < clipEnd(c)) return c;
    }
  }
  const list = clipsOn(p, kind, layer);
  return list.find((c) => t >= c.timelineStart && t < clipEnd(c)) ?? null;
}

export function partner(p: VideoProject, clip: Clip): Clip | null {
  if (!clip.linkGroup) return null;
  return p.clips.find((c) => c.id !== clip.id && c.linkGroup === clip.linkGroup) ?? null;
}

export function isTimelineGap(p: VideoProject, t: number): boolean {
  return !clipAt(p, t, "video", "base") && !clipAt(p, t, "video", "over");
}

export function clipSourcePath(p: VideoProject, c: Clip): string {
  return c.sourcePath || p.sourcePath;
}

export function mapTimelineToSource(p: VideoProject, t: number): { source: number; clip: Clip } | null {
  const c = clipAt(p, t, "video");
  if (!c) return null;
  return { source: c.sourceStart + (t - c.timelineStart), clip: c };
}

export function nextVideoAfter(p: VideoProject, after: number, excludeId?: string): Clip | null {
  const vids = clipsOn(p, "video").filter((c) => c.id !== excludeId && c.timelineStart >= after - 0.001);
  return vids[0] ?? null;
}

export function followSourcePlayback(
  p: VideoProject,
  source: number,
  currentId?: string | null,
): PlaybackFollow {
  const vids = clipsOn(p, "video");
  if (vids.length === 0) return { kind: "stop", timeline: 0 };

  const byId = currentId ? vids.find((c) => c.id === currentId) : undefined;
  // Stick to the clip we're playing; only use source matching if we have no current id.
  let covering =
    byId && source >= byId.sourceStart && source < byId.sourceEnd - 0.002
      ? byId
      : null;
  if (!covering && !currentId) {
    covering = vids.find((c) => source >= c.sourceStart && source < c.sourceEnd) ?? null;
  }

  const leave = (from: Clip): PlaybackFollow => {
    const next = nextVideoAfter(p, clipEnd(from), from.id);
    if (!next) return { kind: "stop", timeline: timelineDuration(p) };
    const hole = next.timelineStart - clipEnd(from);
    if (hole > 0.005) {
      return {
        kind: "gap",
        timeline: clipEnd(from),
        gapEnd: next.timelineStart,
        seekSource: next.sourceStart,
        segmentId: next.id,
      };
    }
    return { kind: "jump", timeline: next.timelineStart, seekSource: next.sourceStart, segmentId: next.id };
  };

  if (byId && source >= byId.sourceEnd - 0.04) return leave(byId);
  if (!covering) {
    const next = vids.find((c) => c.sourceStart >= source - 0.02 || c.timelineStart >= 0);
    const prev = [...vids].reverse().find((c) => c.sourceEnd <= source + 0.05);
    if (prev) return leave(prev);
    if (next) return { kind: "jump", timeline: next.timelineStart, seekSource: next.sourceStart, segmentId: next.id };
    return { kind: "stop", timeline: timelineDuration(p) };
  }

  return {
    kind: "continue",
    timeline: covering.timelineStart + (source - covering.sourceStart),
    segmentId: covering.id,
  };
}

export function snapStart(
  p: VideoProject,
  moving: Clip,
  proposed: number,
  threshold = SNAP,
): number {
  let start = Math.max(0, proposed);
  const dur = clipDuration(moving);
  let best = start;
  let bestDist = Infinity;
  const consider = (c: number, maxDist = threshold) => {
    const v = Math.max(0, c);
    const d = Math.abs(v - start);
    if (d <= maxDist && d < bestDist) {
      bestDist = d;
      best = v;
    }
  };
  consider(0);
  for (const other of p.clips) {
    if (other.id === moving.id) continue;
    if (moving.linkGroup && other.linkGroup === moving.linkGroup) continue;
    consider(clipEnd(other));
    consider(other.timelineStart);
    consider(other.timelineStart - dur);
    consider(clipEnd(other) - dur);
    const av =
      (moving.kind === "video" && other.kind === "audio") || (moving.kind === "audio" && other.kind === "video");
    if (av && Math.abs(clipDuration(other) - dur) <= 0.05) {
      consider(other.timelineStart, Math.max(threshold, 0.18));
    }
  }
  return best;
}

/** Snap a timeline edge to 0 or other clip starts/ends if within threshold. */
export function snapEdge(p: VideoProject, ignoreIds: Set<string>, proposed: number, threshold = SNAP): number {
  let best = Math.max(0, proposed);
  let bestDist = threshold;
  const consider = (c: number) => {
    const v = Math.max(0, c);
    const d = Math.abs(v - proposed);
    if (d <= bestDist) {
      bestDist = d;
      best = v;
    }
  };
  consider(0);
  for (const other of p.clips) {
    if (ignoreIds.has(other.id)) continue;
    consider(other.timelineStart);
    consider(clipEnd(other));
  }
  return best;
}

export type FlatSeg =
  | { gap: false; sourceStart: number; sourceEnd: number; sourcePath: string; gainDb?: number }
  | { gap: true; duration: number };

/** Flatten a kind over the full timeline. Empty regions become gaps (black / silence). */
export function flattenKind(p: VideoProject, kind: ClipKind, layer?: ClipLayer): FlatSeg[] {
  const end = timelineDuration(p);
  if (end <= 0) return [];
  const marks = new Set<number>([0, end]);
  for (const c of clipsOn(p, kind, layer)) {
    marks.add(c.timelineStart);
    marks.add(clipEnd(c));
    for (const g of c.gainSpans ?? []) {
      marks.add(c.timelineStart + (g.sourceStart - c.sourceStart));
      marks.add(c.timelineStart + (g.sourceEnd - c.sourceStart));
    }
  }
  const sorted = [...marks].sort((a, b) => a - b);
  const out: FlatSeg[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a < 0.001) continue;
    const c = clipAt(p, (a + b) / 2, kind, layer);
    if (!c) {
      const last = out[out.length - 1];
      if (last && last.gap) last.duration += b - a;
      else out.push({ gap: true, duration: b - a });
      continue;
    }
    const srcS = c.sourceStart + (a - c.timelineStart);
    const srcE = c.sourceStart + (b - c.timelineStart);
    const srcPath = clipSourcePath(p, c);
    const gainDb = clipGainAtSource(c, srcS);
    const last = out[out.length - 1];
    if (
      last &&
      !last.gap &&
      last.sourcePath === srcPath &&
      Math.abs(last.sourceEnd - srcS) < 0.02 &&
      Math.abs((last.gainDb ?? 0) - gainDb) < 0.05
    ) {
      last.sourceEnd = srcE;
    } else out.push({ gap: false, sourceStart: srcS, sourceEnd: srcE, sourcePath: srcPath, gainDb });
  }
  return out.filter((r) => (r.gap ? r.duration > 0.01 : r.sourceEnd - r.sourceStart > 0.01));
}

export function flattenHasGap(segs: FlatSeg[]): boolean {
  return segs.some((s) => s.gap);
}

export type CompLayer = {
  sourcePath: string;
  sourceStart: number;
  sourceEnd: number;
  x: number;
  y: number;
  scale: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  srcWidth: number;
  srcHeight: number;
  blur: number;
};

export type CompText = {
  text: string;
  fontFamily: string;
  fontSize: number;
  align: string;
  color: string;
  x: number;
  y: number;
  rotation: number;
  boxW: number;
  boxH: number;
  shadow: boolean;
  stroke: boolean;
};

export type CompSlice = {
  duration: number;
  layers: CompLayer[];
  texts: CompText[];
};

function mediaSize(path: string, fallback: MediaInfo, byPath: Record<string, MediaInfo>) {
  const m = byPath[path] ?? (fallback.path === path ? fallback : fallback);
  return { w: m.width || 1920, h: m.height || 1080 };
}

export function flattenCanvas(
  p: VideoProject,
  fallback: MediaInfo,
  byPath: Record<string, MediaInfo> = {},
): CompSlice[] {
  const end = timelineDuration(p);
  if (end <= 0) return [];
  const marks = new Set<number>([0, end]);
  for (const c of [...clipsOn(p, "video"), ...clipsOn(p, "text")]) {
    marks.add(c.timelineStart);
    marks.add(clipEnd(c));
    for (const k of c.anim ?? []) marks.add(c.timelineStart + k.t);
  }
  const sorted = [...marks].sort((a, b) => a - b);
  const spans: { a: number; b: number }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a < 0.01) continue;
    const moving = [...clipsOn(p, "video"), ...clipsOn(p, "text")].some((c) => {
      const keys = [...(c.anim ?? [])].sort((x, y) => x.t - y.t);
      if (keys.length < 2 || !(c.timelineStart < b && clipEnd(c) > a)) return false;
      const local = a - c.timelineStart;
      let left: (typeof keys)[number] | null = null;
      for (const k of keys) if (k.t <= local + 1e-3) left = k;
      if (!left) return false;
      const next = keys.find((k) => k.t > left.t + 1e-3);
      return !!next && next.channels?.blend !== false;
    });
    if (!moving || b - a < 0.09) {
      spans.push({ a, b });
      continue;
    }
    const step = 1 / 12;
    for (let t = a; t < b - 0.01; t += step) spans.push({ a: t, b: Math.min(b, t + step) });
  }
  const out: CompSlice[] = [];
  for (const { a, b } of spans) {
    const mid = (a + b) / 2;
    const layers: CompLayer[] = [];
    const texts: CompText[] = [];
    for (const layer of ["base", "over"] as const) {
      const c = clipAt(p, mid, "video", layer);
      if (c) {
        const path = clipSourcePath(p, c);
        const size = mediaSize(path, fallback, byPath);
        const xf: ClipTransform = poseAt(c, mid);
        layers.push({
          sourcePath: path,
          sourceStart: c.sourceStart + (a - c.timelineStart),
          sourceEnd: c.sourceStart + (b - c.timelineStart),
          x: xf.x,
          y: xf.y,
          scale: xf.scale,
          scaleX: xfScaleX(xf),
          scaleY: xfScaleY(xf),
          rotation: xf.rotation,
          srcWidth: size.w,
          srcHeight: size.h,
          blur: clipBlur(c),
        });
      }
      const tx = clipAt(p, mid, "text", layer);
      if (tx && (tx.text ?? "").length) {
        const xf = poseAt(tx, mid);
        texts.push({
          text: tx.text ?? "",
          fontFamily: tx.fontFamily ?? "Segoe UI",
          fontSize: (tx.fontSize ?? 64) * xfScaleY(xf),
          align: tx.textAlign ?? "center",
          color: tx.textColor ?? "#ffffff",
          x: xf.x,
          y: xf.y,
          rotation: xf.rotation,
          boxW: (tx.boxW ?? 200) * xfScaleX(xf),
          boxH: (tx.boxH ?? 80) * xfScaleY(xf),
          shadow: !!tx.textShadow,
          stroke: !!tx.textStroke,
        });
      }
    }
    out.push({ duration: b - a, layers, texts });
  }
  return out;
}

export function replaceClips(p: VideoProject, clips: Clip[]): VideoProject {
  return { ...p, clips: clips.map(cloneClip) };
}

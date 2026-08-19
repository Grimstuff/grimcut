import {
  type Clip,
  type ClipKind,
  type ClipLayer,
  type MediaInfo,
  type PlaybackFollow,
  type VideoProject,
  clipDuration,
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
  return { sourcePath: info.path, sourceDuration: info.duration, clips };
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
  const list = clipsOn(p, kind, layer);
  // Overlay wins if no layer specified
  if (!layer) {
    const over = list.find((c) => c.layer === "over" && t >= c.timelineStart && t < clipEnd(c));
    if (over) return over;
  }
  return list.find((c) => t >= c.timelineStart && t < clipEnd(c)) ?? null;
}

export function partner(p: VideoProject, clip: Clip): Clip | null {
  if (!clip.linkGroup) return null;
  return p.clips.find((c) => c.id !== clip.id && c.linkGroup === clip.linkGroup) ?? null;
}

export function isTimelineGap(p: VideoProject, t: number): boolean {
  return clipAt(p, t, "video") === null;
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
  let bestDist = threshold;
  const consider = (c: number) => {
    const v = Math.max(0, c);
    const d = Math.abs(v - start);
    if (d <= bestDist) {
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
  }
  return best;
}

export type FlatSeg =
  | { gap: false; sourceStart: number; sourceEnd: number }
  | { gap: true; duration: number };

/** Flatten a kind over the full timeline. Empty regions become gaps (black / silence). */
export function flattenKind(p: VideoProject, kind: ClipKind): FlatSeg[] {
  const end = timelineDuration(p);
  if (end <= 0) return [];
  const marks = new Set<number>([0, end]);
  for (const c of clipsOn(p, kind)) {
    marks.add(c.timelineStart);
    marks.add(clipEnd(c));
  }
  const sorted = [...marks].sort((a, b) => a - b);
  const out: FlatSeg[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b - a < 0.001) continue;
    const c = clipAt(p, (a + b) / 2, kind);
    if (!c) {
      const last = out[out.length - 1];
      if (last && last.gap) last.duration += b - a;
      else out.push({ gap: true, duration: b - a });
      continue;
    }
    const srcS = c.sourceStart + (a - c.timelineStart);
    const srcE = c.sourceStart + (b - c.timelineStart);
    const last = out[out.length - 1];
    if (last && !last.gap && Math.abs(last.sourceEnd - srcS) < 0.02) last.sourceEnd = srcE;
    else out.push({ gap: false, sourceStart: srcS, sourceEnd: srcE });
  }
  return out.filter((r) => (r.gap ? r.duration > 0.01 : r.sourceEnd - r.sourceStart > 0.01));
}

export function flattenHasGap(segs: FlatSeg[]): boolean {
  return segs.some((s) => s.gap);
}

export function replaceClips(p: VideoProject, clips: Clip[]): VideoProject {
  return { ...p, clips: clips.map(cloneClip) };
}

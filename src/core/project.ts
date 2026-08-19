import {
  type ClipSegment,
  type MediaInfo,
  type PlaybackFollow,
  type VideoProject,
  clipDuration,
  clipTimelineEnd,
  cloneClip,
  newId,
} from "./types";

export function fromMedia(info: MediaInfo): VideoProject {
  const duration = info.duration > 0 ? info.duration : 1;
  return {
    sourcePath: info.path,
    sourceDuration: info.duration,
    segments: [
      {
        id: newId(),
        timelineStart: 0,
        sourceStart: 0,
        sourceEnd: duration,
      },
    ],
  };
}

export function timelineDuration(p: VideoProject): number {
  let max = 0;
  for (const s of p.segments) max = Math.max(max, clipTimelineEnd(s));
  return max;
}

export function rulerDuration(p: VideoProject): number {
  return Math.max(p.sourceDuration, timelineDuration(p), 1);
}

export function segmentsByTimeline(p: VideoProject): ClipSegment[] {
  return [...p.segments].sort((a, b) => a.timelineStart - b.timelineStart || a.id.localeCompare(b.id));
}

export function clampTimeline(p: VideoProject, t: number): number {
  const total = timelineDuration(p);
  if (t < 0) return 0;
  if (total <= 0) return 0;
  return t > total ? total : t;
}

export function getSegmentAtTimeline(
  p: VideoProject,
  t: number,
): { segment: ClipSegment; index: number } | null {
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    if (t >= s.timelineStart && t < clipTimelineEnd(s)) return { segment: s, index: i };
  }
  for (let i = 0; i < p.segments.length; i++) {
    const s = p.segments[i];
    if (t === clipTimelineEnd(s) && clipDuration(s) > 0) return { segment: s, index: i };
  }
  return null;
}

export function mapTimelineToSource(
  p: VideoProject,
  t: number,
): { source: number; segment: ClipSegment } | null {
  for (const s of p.segments) {
    if (t >= s.timelineStart && t < clipTimelineEnd(s)) {
      return { source: s.sourceStart + (t - s.timelineStart), segment: s };
    }
    if (t === clipTimelineEnd(s) && clipDuration(s) > 0) {
      return { source: s.sourceEnd, segment: s };
    }
  }
  return null;
}

export function isTimelineGap(p: VideoProject, t: number): boolean {
  return getSegmentAtTimeline(p, t) === null;
}

export function nextClipAfter(p: VideoProject, after: number, excludeId?: string): ClipSegment | null {
  let best: ClipSegment | null = null;
  for (const s of segmentsByTimeline(p)) {
    if (excludeId && s.id === excludeId) continue;
    if (s.timelineStart >= after - 0.001) {
      if (!best || s.timelineStart < best.timelineStart) best = s;
    }
  }
  return best;
}

function findCovering(p: VideoProject, source: number, preferredId?: string | null): ClipSegment | null {
  if (preferredId) {
    const pref = p.segments.find((s) => s.id === preferredId);
    if (pref && source >= pref.sourceStart && source < pref.sourceEnd) return pref;
  }
  return p.segments.find((s) => source >= s.sourceStart && source < s.sourceEnd) ?? null;
}

export function isSourceVoid(p: VideoProject, source: number): boolean {
  return findCovering(p, source, null) === null;
}

function leaveClip(p: VideoProject, cur: ClipSegment): PlaybackFollow {
  const next = nextClipAfter(p, clipTimelineEnd(cur), cur.id);
  if (!next) return { kind: "stop", timeline: timelineDuration(p) };
  const hole = next.timelineStart - clipTimelineEnd(cur);
  if (hole > 0.005) {
    return {
      kind: "gap",
      timeline: clipTimelineEnd(cur),
      gapEnd: next.timelineStart,
      seekSource: next.sourceStart,
      segmentId: next.id,
    };
  }
  return { kind: "jump", timeline: next.timelineStart, seekSource: next.sourceStart, segmentId: next.id };
}

export function followSourcePlayback(
  p: VideoProject,
  source: number,
  currentId?: string | null,
): PlaybackFollow {
  if (p.segments.length === 0) return { kind: "stop", timeline: 0 };
  const covering = findCovering(p, source, currentId);
  if (!covering) return resolveSourceVoid(p, source, currentId);

  const next = nextClipAfter(p, clipTimelineEnd(covering), covering.id);
  if (next && source >= covering.sourceEnd - 0.035) return leaveClip(p, covering);
  if (source >= covering.sourceEnd) return leaveClip(p, covering);

  return {
    kind: "continue",
    timeline: covering.timelineStart + (source - covering.sourceStart),
    segmentId: covering.id,
  };
}

export function resolveSourceVoid(
  p: VideoProject,
  source: number,
  currentId?: string | null,
): PlaybackFollow {
  let prev: ClipSegment | null = null;
  for (const s of p.segments) {
    if (s.sourceEnd <= source + 0.001) {
      if (!prev || s.sourceEnd > prev.sourceEnd || (s.sourceEnd === prev.sourceEnd && clipTimelineEnd(s) > clipTimelineEnd(prev))) {
        prev = s;
      }
    }
  }
  if (currentId) {
    const cur = p.segments.find((s) => s.id === currentId);
    if (cur && cur.sourceEnd <= source + 0.05) prev = cur;
  }

  let next: ClipSegment | null = null;
  for (const s of segmentsByTimeline(p)) {
    if (s.sourceStart >= source - 0.001) {
      next = s;
      break;
    }
  }
  if (!next && prev) next = nextClipAfter(p, clipTimelineEnd(prev), prev.id);

  if (!prev && !next) return { kind: "stop", timeline: timelineDuration(p) };
  if (!prev && next) {
    if (next.timelineStart > 0.005) {
      return {
        kind: "gap",
        timeline: 0,
        gapEnd: next.timelineStart,
        seekSource: next.sourceStart,
        segmentId: next.id,
      };
    }
    return { kind: "jump", timeline: next.timelineStart, seekSource: next.sourceStart, segmentId: next.id };
  }
  if (prev && !next) return { kind: "stop", timeline: clipTimelineEnd(prev) };
  return leaveClip(p, prev!);
}

export function snapTimelineStart(
  p: VideoProject,
  movingId: string,
  proposed: number,
  duration: number,
  threshold = 0.08,
): number {
  let start = Math.max(0, proposed);
  let best = start;
  let bestDist = threshold;

  const consider = (candidate: number) => {
    const c = Math.max(0, candidate);
    const dist = Math.abs(c - start);
    if (dist <= bestDist) {
      bestDist = dist;
      best = c;
    }
  };

  consider(0);
  for (const other of p.segments) {
    if (other.id === movingId) continue;
    consider(clipTimelineEnd(other));
    consider(other.timelineStart);
    consider(other.timelineStart - duration);
    consider(clipTimelineEnd(other) - duration);
  }
  return best;
}

export function replaceSegments(p: VideoProject, next: ClipSegment[]): VideoProject {
  return { ...p, segments: next.map(cloneClip) };
}

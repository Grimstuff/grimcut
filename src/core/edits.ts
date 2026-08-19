import { type ClipSegment, type VideoProject, MIN_CLIP, clipDuration, cloneClip, newId } from "./types";
import { getSegmentAtTimeline } from "./project";

export type EditResult = { ok: true; segments: ClipSegment[] } | { ok: false; error: string };

export function tryCut(p: VideoProject, playhead: number): EditResult {
  const hit = getSegmentAtTimeline(p, playhead);
  if (!hit) return { ok: false, error: "Playhead is not on a clip." };
  const { segment, index } = hit;
  const offset = playhead - segment.timelineStart;
  if (offset <= MIN_CLIP || clipDuration(segment) - offset <= MIN_CLIP) {
    return { ok: false, error: "Move the playhead away from a clip edge, then cut again." };
  }
  const sourceCut = segment.sourceStart + offset;
  const left: ClipSegment = {
    id: newId(),
    timelineStart: segment.timelineStart,
    sourceStart: segment.sourceStart,
    sourceEnd: sourceCut,
  };
  const right: ClipSegment = {
    id: newId(),
    timelineStart: playhead,
    sourceStart: sourceCut,
    sourceEnd: segment.sourceEnd,
  };
  const next = p.segments.map(cloneClip);
  next.splice(index, 1, left, right);
  return { ok: true, segments: next };
}

export function tryDelete(p: VideoProject, id: string): EditResult {
  if (p.segments.length <= 1) return { ok: false, error: "Can't delete the only remaining clip." };
  const index = p.segments.findIndex((s) => s.id === id);
  if (index < 0) return { ok: false, error: "No clip selected." };
  const next = p.segments.map(cloneClip);
  next.splice(index, 1);
  return { ok: true, segments: next };
}

export function tryTrim(
  p: VideoProject,
  id: string,
  patch: { sourceStart?: number; sourceEnd?: number; timelineStart?: number },
): EditResult {
  const index = p.segments.findIndex((s) => s.id === id);
  if (index < 0) return { ok: false, error: "No clip selected." };
  const next = p.segments.map(cloneClip);
  const seg = next[index];
  let sourceStart = patch.sourceStart ?? seg.sourceStart;
  let sourceEnd = patch.sourceEnd ?? seg.sourceEnd;
  let timelineStart = patch.timelineStart ?? seg.timelineStart;
  if (sourceStart < 0) sourceStart = 0;
  if (p.sourceDuration > 0 && sourceEnd > p.sourceDuration) sourceEnd = p.sourceDuration;
  if (timelineStart < 0) timelineStart = 0;
  if (sourceEnd - sourceStart < MIN_CLIP) return { ok: false, error: "Clip would be too short." };
  seg.sourceStart = sourceStart;
  seg.sourceEnd = sourceEnd;
  seg.timelineStart = timelineStart;
  return { ok: true, segments: next };
}

export function tryMove(p: VideoProject, id: string, timelineStart: number): EditResult {
  const index = p.segments.findIndex((s) => s.id === id);
  if (index < 0) return { ok: false, error: "No clip selected." };
  const next = p.segments.map(cloneClip);
  next[index].timelineStart = Math.max(0, timelineStart);
  return { ok: true, segments: next };
}

export class UndoStack {
  private undo: { before: ClipSegment[]; after: ClipSegment[]; description: string }[] = [];
  private redo: { before: ClipSegment[]; after: ClipSegment[]; description: string }[] = [];

  get canUndo() {
    return this.undo.length > 0;
  }
  get canRedo() {
    return this.redo.length > 0;
  }
  get undoLabel() {
    return this.undo.length ? `Undo ${this.undo[this.undo.length - 1].description}` : "Undo";
  }
  get redoLabel() {
    return this.redo.length ? `Redo ${this.redo[this.redo.length - 1].description}` : "Redo";
  }

  push(before: ClipSegment[], after: ClipSegment[], description: string) {
    this.undo.push({ before: before.map((s) => ({ ...s })), after: after.map((s) => ({ ...s })), description });
    this.redo = [];
  }

  popUndo(): ClipSegment[] | null {
    const e = this.undo.pop();
    if (!e) return null;
    this.redo.push(e);
    return e.before.map((s) => ({ ...s }));
  }

  popRedo(): ClipSegment[] | null {
    const e = this.redo.pop();
    if (!e) return null;
    this.undo.push(e);
    return e.after.map((s) => ({ ...s }));
  }

  clear() {
    this.undo = [];
    this.redo = [];
  }
}

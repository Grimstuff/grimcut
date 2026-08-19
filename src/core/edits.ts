import {
  type Clip,
  type ClipKind,
  type ClipLayer,
  type ClipboardChunk,
  type VideoProject,
  MIN_CLIP,
  clipDuration,
  clipEnd,
  cloneClip,
  newId,
} from "./types";
import { clipAt, partner } from "./project";

export type EditResult = { ok: true; clips: Clip[] } | { ok: false; error: string };

function sliceOne(clip: Clip, at: number): Clip[] | null {
  const offset = at - clip.timelineStart;
  if (offset <= MIN_CLIP || clipDuration(clip) - offset <= MIN_CLIP) return null;
  const src = clip.sourceStart + offset;
  const left: Clip = {
    ...clip,
    id: newId(),
    sourceEnd: src,
  };
  const right: Clip = {
    ...clip,
    id: newId(),
    timelineStart: at,
    sourceStart: src,
    linkGroup: clip.linkGroup ? newId() : null,
  };
  if (left.linkGroup && right.linkGroup) {
    // left keeps old group; right gets new — caller remaps partners
  }
  return [left, right];
}

/** Split every clip (and its linked partner) under the playhead. */
export function trySlice(p: VideoProject, at: number, onlyId?: string): EditResult {
  let clips = p.clips.map(cloneClip);
  const targets = onlyId
    ? clips.filter((c) => c.id === onlyId || (c.linkGroup && clips.find((x) => x.id === onlyId)?.linkGroup === c.linkGroup))
    : clips.filter((c) => at > c.timelineStart && at < clipEnd(c));

  if (targets.length === 0) return { ok: false, error: "Nothing under the playhead to slice." };

  const remove = new Set<string>();
  const add: Clip[] = [];
  const groupMap = new Map<string, { left: string; right: string }>();

  for (const t of targets) {
    const parts = sliceOne(t, at);
    if (!parts) continue;
    remove.add(t.id);
    if (t.linkGroup) {
      let g = groupMap.get(t.linkGroup);
      if (!g) {
        g = { left: t.linkGroup, right: newId() };
        groupMap.set(t.linkGroup, g);
      }
      parts[0].linkGroup = g.left;
      parts[1].linkGroup = g.right;
    }
    add.push(...parts);
  }

  if (add.length === 0) return { ok: false, error: "Move off the clip edge, then slice." };
  clips = clips.filter((c) => !remove.has(c.id)).concat(add);
  return { ok: true, clips };
}

export function tryDelete(p: VideoProject, id: string): EditResult {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { ok: false, error: "No clip selected." };
  const ids = new Set([id]);
  const mate = partner(p, clip);
  if (mate) ids.add(mate.id);
  const clips = p.clips.filter((c) => !ids.has(c.id));
  if (clips.filter((c) => c.kind === "video" && c.layer === "base").length === 0 && clip.kind === "video" && clip.layer === "base") {
    if (p.clips.filter((c) => c.kind === "video").length <= 1) {
      return { ok: false, error: "Can't delete the only remaining video." };
    }
  }
  return { ok: true, clips };
}

export function tryTrim(
  p: VideoProject,
  id: string,
  edge: "left" | "right",
  newSourceEdge: number,
): EditResult {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { ok: false, error: "No clip selected." };

  const apply = (c: Clip): Clip => {
    const next = { ...c };
    if (edge === "left") {
      let start = Math.max(0, newSourceEdge);
      if (p.sourceDuration > 0) start = Math.min(start, p.sourceDuration);
      if (start > next.sourceEnd - MIN_CLIP) start = next.sourceEnd - MIN_CLIP;
      const delta = start - next.sourceStart;
      next.sourceStart = start;
      next.timelineStart = Math.max(0, next.timelineStart + delta);
    } else {
      let end = newSourceEdge;
      if (p.sourceDuration > 0) end = Math.min(end, p.sourceDuration);
      if (end < next.sourceStart + MIN_CLIP) end = next.sourceStart + MIN_CLIP;
      next.sourceEnd = end;
    }
    return next;
  };

  const clips = p.clips.map((c) => {
    if (c.id === id) return apply(c);
    if (clip.linkGroup && c.linkGroup === clip.linkGroup) return apply(c);
    return cloneClip(c);
  });
  return { ok: true, clips };
}

export function tryMove(p: VideoProject, id: string, timelineStart: number): EditResult {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { ok: false, error: "No clip selected." };
  const delta = Math.max(0, timelineStart) - clip.timelineStart;
  const clips = p.clips.map((c) => {
    if (c.id === id || (clip.linkGroup && c.linkGroup === clip.linkGroup)) {
      return { ...c, timelineStart: Math.max(0, c.timelineStart + delta) };
    }
    return cloneClip(c);
  });
  return { ok: true, clips };
}

export function tryToggleLink(p: VideoProject, id: string): EditResult {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { ok: false, error: "No clip selected." };
  const clips = p.clips.map(cloneClip);
  const me = clips.find((c) => c.id === id)!;
  if (me.linkGroup) {
    const g = me.linkGroup;
    for (const c of clips) if (c.linkGroup === g) c.linkGroup = null;
    return { ok: true, clips };
  }
  const otherKind: ClipKind = me.kind === "video" ? "audio" : "video";
  const mate =
    clipAt({ ...p, clips }, me.timelineStart + clipDuration(me) / 2, otherKind, me.layer) ??
    clips.find((c) => c.kind === otherKind && c.layer === me.layer);
  if (!mate) return { ok: false, error: "Nothing to link to." };
  const g = newId();
  me.linkGroup = g;
  mate.linkGroup = g;
  return { ok: true, clips };
}

export function tryPaste(
  p: VideoProject,
  chunk: ClipboardChunk,
  at: number,
  preferLayer: ClipLayer = "base",
): EditResult {
  const dur = chunk.sourceEnd - chunk.sourceStart;
  if (dur < MIN_CLIP) return { ok: false, error: "Clipboard is empty." };
  let layer: ClipLayer = preferLayer;
  const overlapBase = p.clips.some(
    (c) =>
      c.kind === chunk.kind &&
      c.layer === "base" &&
      at < clipEnd(c) &&
      at + dur > c.timelineStart,
  );
  if (overlapBase && preferLayer === "base") layer = "over";

  const clips = p.clips.map(cloneClip);
  if (layer === "over") {
    // max one overlay of this kind
    const rest = clips.filter((c) => !(c.kind === chunk.kind && c.layer === "over"));
    rest.push({
      id: newId(),
      kind: chunk.kind,
      layer: "over",
      timelineStart: Math.max(0, at),
      sourceStart: chunk.sourceStart,
      sourceEnd: chunk.sourceEnd,
      linkGroup: null,
    });
    return { ok: true, clips: rest };
  }
  clips.push({
    id: newId(),
    kind: chunk.kind,
    layer: "base",
    timelineStart: Math.max(0, at),
    sourceStart: chunk.sourceStart,
    sourceEnd: chunk.sourceEnd,
    linkGroup: null,
  });
  return { ok: true, clips };
}

export function chunkFromRange(
  p: VideoProject,
  kind: ClipKind,
  start: number,
  end: number,
): ClipboardChunk | null {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a < MIN_CLIP) return null;
  const c = clipAt(p, (a + b) / 2, kind) ?? clipAt(p, a, kind);
  if (!c) return null;
  const srcA = c.sourceStart + (Math.max(a, c.timelineStart) - c.timelineStart);
  const srcB = c.sourceStart + (Math.min(b, clipEnd(c)) - c.timelineStart);
  if (srcB - srcA < MIN_CLIP) return null;
  return { kind, sourceStart: srcA, sourceEnd: srcB };
}

export class UndoStack {
  private undo: { before: Clip[]; after: Clip[]; description: string }[] = [];
  private redo: { before: Clip[]; after: Clip[]; description: string }[] = [];

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

  push(before: Clip[], after: Clip[], description: string) {
    this.undo.push({
      before: before.map((s) => ({ ...s })),
      after: after.map((s) => ({ ...s })),
      description,
    });
    this.redo = [];
  }

  popUndo(): Clip[] | null {
    const e = this.undo.pop();
    if (!e) return null;
    this.redo.push(e);
    return e.before.map((s) => ({ ...s }));
  }

  popRedo(): Clip[] | null {
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

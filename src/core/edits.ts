import {
  type Clip,
  type ClipKind,
  type ClipLayer,
  type ClipboardChunk,
  type MediaInfo,
  type VideoProject,
  MIN_CLIP,
  clipDuration,
  clipEnd,
  cloneClip,
  newId,
} from "./types";
import { defaultTransform } from "./canvas";
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

  const ids = new Set<string>([id]);
  if (clip.linkGroup) {
    for (const c of p.clips) if (c.linkGroup === clip.linkGroup) ids.add(c.id);
  }
  const clips = p.clips.map((c) => {
    if (ids.has(c.id)) return apply(c);
    return cloneClip(c);
  });
  return resolveOccupancy({ ...p, clips }, ids);
}

function rangeOverlaps(c: Clip, start: number, end: number) {
  return c.timelineStart < end && clipEnd(c) > start;
}

/** Split clips of this kind+layer around [start, end). Linked partners split with them. */
function punchLayer(
  clips: Clip[],
  kind: ClipKind,
  layer: ClipLayer,
  start: number,
  end: number,
  keep: Set<string>,
): Clip[] {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a < MIN_CLIP) return clips.map(cloneClip);
  const hit = new Set<string>();
  for (const c of clips) {
    if (keep.has(c.id) || c.kind !== kind || c.layer !== layer) continue;
    if (b <= c.timelineStart || a >= clipEnd(c)) continue;
    hit.add(c.id);
    if (c.linkGroup) {
      for (const m of clips) if (m.linkGroup === c.linkGroup) hit.add(m.id);
    }
  }
  if (hit.size === 0) return clips.map(cloneClip);
  const leftGroup = new Map<string, string>();
  const rightGroup = new Map<string, string>();
  const next: Clip[] = [];
  for (const c of clips) {
    if (!hit.has(c.id)) {
      next.push(cloneClip(c));
      continue;
    }
    const t0 = c.timelineStart;
    const t1 = clipEnd(c);
    if (a > t0 + MIN_CLIP) {
      let g = c.linkGroup;
      if (g) {
        if (!leftGroup.has(g)) leftGroup.set(g, g);
        g = leftGroup.get(g)!;
      }
      next.push({ ...cloneClip(c), id: newId(), sourceEnd: c.sourceStart + (a - t0), linkGroup: g ?? null });
    }
    if (b < t1 - MIN_CLIP) {
      let g: string | null = c.linkGroup;
      if (g) {
        if (!rightGroup.has(g)) rightGroup.set(g, newId());
        g = rightGroup.get(g)!;
      }
      next.push({
        ...cloneClip(c),
        id: newId(),
        timelineStart: b,
        sourceStart: c.sourceStart + (b - t0),
        linkGroup: g,
      });
    }
  }
  return next;
}

/**
 * One clip per kind per layer at any time.
 * Overlapping base → the placed clip(s) go to overlay.
 * Overlapping overlay → punch a hole in the existing overlay and sit in it.
 */
export function resolveOccupancy(p: VideoProject, placedIds: Set<string>): EditResult {
  const clips = p.clips.map(cloneClip);
  for (const me of clips) {
    if (!placedIds.has(me.id) || me.layer !== "base") continue;
    const start = me.timelineStart;
    const end = clipEnd(me);
    const hit = clips.some(
      (c) => !placedIds.has(c.id) && c.kind === me.kind && c.layer === "base" && rangeOverlaps(c, start, end),
    );
    if (!hit) continue;
    me.layer = "over";
    if (me.linkGroup) {
      for (const c of clips) if (c.linkGroup === me.linkGroup) c.layer = "over";
    }
  }
  let next = clips;
  for (const me of clips) {
    if (!placedIds.has(me.id) || me.layer !== "over") continue;
    next = punchLayer(next, me.kind, "over", me.timelineStart, clipEnd(me), placedIds);
  }
  for (const me of next) {
    if (me.layer !== "over") continue;
    const start = me.timelineStart;
    const end = clipEnd(me);
    const covering = next.some((c) => c.id !== me.id && c.kind === me.kind && rangeOverlaps(c, start, end));
    if (!covering) me.layer = "base";
  }
  if (next.filter((c) => c.kind === "video").length === 0) {
    return { ok: false, error: "That would remove all video." };
  }
  return { ok: true, clips: next };
}

export function tryMove(p: VideoProject, id: string, timelineStart: number): EditResult {
  const clip = p.clips.find((c) => c.id === id);
  if (!clip) return { ok: false, error: "No clip selected." };
  const ids = new Set<string>([id]);
  if (clip.linkGroup) {
    for (const c of p.clips) if (c.linkGroup === clip.linkGroup) ids.add(c.id);
  }
  const delta = Math.max(0, timelineStart) - clip.timelineStart;
  const clips = p.clips.map((c) => {
    if (ids.has(c.id)) return { ...c, timelineStart: Math.max(0, c.timelineStart + delta) };
    return cloneClip(c);
  });
  return resolveOccupancy({ ...p, clips }, ids);
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

/** Remove [start, end) from overlapping clips (and linked partners). Leaves a hole. */
export function tryLiftRange(
  p: VideoProject,
  kind: ClipKind,
  start: number,
  end: number,
): EditResult {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a < MIN_CLIP) return { ok: false, error: "Selection too small." };

  const hit = new Set<string>();
  for (const c of p.clips) {
    if (c.kind !== kind) continue;
    if (b <= c.timelineStart || a >= clipEnd(c)) continue;
    hit.add(c.id);
    const mate = partner(p, c);
    if (mate) hit.add(mate.id);
  }
  if (hit.size === 0) return { ok: false, error: "Nothing in that range." };

  const leftGroup = new Map<string, string>();
  const rightGroup = new Map<string, string>();
  const next: Clip[] = [];
  for (const c of p.clips) {
    if (!hit.has(c.id)) {
      next.push(cloneClip(c));
      continue;
    }
    const t0 = c.timelineStart;
    const t1 = clipEnd(c);
    if (a > t0 + MIN_CLIP) {
      const srcEnd = c.sourceStart + (a - t0);
      let g = c.linkGroup;
      if (g) {
        if (!leftGroup.has(g)) leftGroup.set(g, g);
        g = leftGroup.get(g)!;
      }
      next.push({ ...cloneClip(c), id: newId(), sourceEnd: srcEnd, linkGroup: g ?? null });
    }
    if (b < t1 - MIN_CLIP) {
      const srcStart = c.sourceStart + (b - t0);
      let g: string | null = c.linkGroup;
      if (g) {
        if (!rightGroup.has(g)) rightGroup.set(g, newId());
        g = rightGroup.get(g)!;
      }
      next.push({
        ...cloneClip(c),
        id: newId(),
        timelineStart: b,
        sourceStart: srcStart,
        linkGroup: g,
      });
    }
  }
  if (next.filter((c) => c.kind === "video").length === 0) {
    return { ok: false, error: "That would remove all video." };
  }
  return { ok: true, clips: next };
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
  const placed = newId();
  clips.push({
    id: placed,
    kind: chunk.kind,
    layer,
    timelineStart: Math.max(0, at),
    sourceStart: chunk.sourceStart,
    sourceEnd: chunk.sourceEnd,
    linkGroup: null,
    sourcePath: chunk.sourcePath,
    transform: defaultTransform(),
  });
  return resolveOccupancy({ ...p, clips }, new Set([placed]));
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
  return { kind, sourceStart: srcA, sourceEnd: srcB, sourcePath: c.sourcePath };
}

/** Place a media file on overlay (2nd layer) at `at`. Keeps existing overlay clips. */
export function tryAddOverlayFromMedia(p: VideoProject, info: MediaInfo, at: number): EditResult {
  const duration = info.duration > 0 ? info.duration : 0;
  if (duration < MIN_CLIP) return { ok: false, error: "That file is too short." };
  const start = Math.max(0, at);
  const other = info.path !== p.sourcePath ? info.path : undefined;
  const group = newId();
  const clips = p.clips.map(cloneClip);
  const ids = new Set<string>();
  const vid = newId();
  ids.add(vid);
  clips.push({
    id: vid,
    kind: "video",
    layer: "over",
    timelineStart: start,
    sourceStart: 0,
    sourceEnd: duration,
    linkGroup: info.hasAudio ? group : null,
    sourcePath: other,
    transform: defaultTransform(),
  });
  if (info.hasAudio) {
    const aud = newId();
    ids.add(aud);
    clips.push({
      id: aud,
      kind: "audio",
      layer: "over",
      timelineStart: start,
      sourceStart: 0,
      sourceEnd: duration,
      linkGroup: group,
      sourcePath: other,
    });
  }
  return resolveOccupancy({ ...p, clips }, ids);
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

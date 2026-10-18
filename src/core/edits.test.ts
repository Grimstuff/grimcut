import { describe, expect, it } from "vitest";
import { poseAt, writeTransform } from "./canvas";
import { fromMedia, flattenCanvas, flattenKind, mapTimelineToSource, snapStart, timelineDuration } from "./project";
import { collectLaneSpans, extractSpans, tryAddOverlayFromMedia, tryAddText, tryDelete, tryLiftRange, tryLinkPair, tryMove, tryMoveIds, trySlice, tryToggleLink, tryTrim } from "./edits";
import type { MediaInfo } from "./types";

const info: MediaInfo = {
  path: "C:/x.mp4",
  duration: 10,
  hasAudio: true,
  keyframeTimes: [0, 2, 4],
};

describe("timeline model", () => {
  it("canvas defaults to media size", () => {
    const p = fromMedia({ ...info, width: 1920, height: 1080 });
    expect(p.canvasWidth).toBe(1920);
    expect(p.canvasHeight).toBe(1080);
    const slices = flattenCanvas(p, { ...info, width: 1920, height: 1080 });
    expect(slices[0].layers).toHaveLength(1);
    expect(slices[0].layers[0].scale).toBe(1);
  });

  it("text layer sits on overlay if base is occupied", () => {
    const p = fromMedia(info);
    const r = tryAddText(p, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tx = r.clips.find((c) => c.kind === "text");
    expect(tx?.layer).toBe("over");
    expect(tx?.sourceEnd).toBe(3);
  });

  it("opens with linked video+audio", () => {
    const p = fromMedia(info);
    expect(p.clips).toHaveLength(2);
    expect(p.clips[0].linkGroup).toBe(p.clips[1].linkGroup);
    expect(p.clips[0].linkGroup).toBeTruthy();
  });

  it("slice splits both linked clips", () => {
    const p = fromMedia(info);
    const r = trySlice(p, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips.filter((c) => c.kind === "video")).toHaveLength(2);
    expect(r.clips.filter((c) => c.kind === "audio")).toHaveLength(2);
  });

  it("delete linked pair together", () => {
    let p = fromMedia(info);
    const s = trySlice(p, 4);
    if (!s.ok) throw new Error("slice");
    p = { ...p, clips: s.clips };
    const leftV = p.clips.find((c) => c.kind === "video" && c.timelineStart === 0)!;
    const d = tryDelete(p, leftV.id);
    if (!d.ok) throw new Error(d.error);
    expect(d.clips.filter((c) => c.kind === "video")).toHaveLength(1);
    expect(d.clips.filter((c) => c.kind === "audio")).toHaveLength(1);
    expect(timelineDuration({ ...p, clips: d.clips })).toBe(10);
  });

  it("linked group cannot slide a later audio past the video at 0", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    const a = p.clips.find((c) => c.kind === "audio")!;
    v.timelineStart = 2;
    a.timelineStart = 6;
    a.sourceEnd = 8;
    const r = tryMove(p, a.id, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const nv = r.clips.find((c) => c.id === v.id)!;
    const na = r.clips.find((c) => c.id === a.id)!;
    expect(nv.timelineStart).toBe(0);
    expect(na.timelineStart).toBe(4);
  });

  it("moving a base video takes overlapping overlay with it", () => {
    const p = fromMedia(info);
    const extra = tryAddOverlayFromMedia(p, { ...info, path: "C:/b.mp4", duration: 3, hasAudio: true }, 2);
    expect(extra.ok).toBe(true);
    if (!extra.ok) return;
    const p2 = { ...p, clips: extra.clips };
    const baseV = p2.clips.find((c) => c.kind === "video" && c.layer === "base")!;
    const overV = p2.clips.find((c) => c.kind === "video" && c.layer === "over")!;
    const moved = tryMove(p2, baseV.id, 1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const over2 = moved.clips.find((c) => c.id === overV.id)!;
    expect(over2.timelineStart).toBeCloseTo(3);
  });

  it("overlapping base audio is promoted to overlay", () => {
    const p = fromMedia(info);
    const cut = trySlice(p, 5);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const p2 = { ...p, clips: cut.clips };
    for (const c of [...p2.clips]) {
      if (!c.linkGroup) continue;
      const u = tryToggleLink(p2, c.id);
      if (u.ok) p2.clips = u.clips;
    }
    const leftA = p2.clips.find((c) => c.kind === "audio" && Math.abs(c.timelineStart) < 0.01)!;
    const moved = tryMove(p2, leftA.id, 3);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.clips.find((c) => c.id === leftA.id)?.layer).toBe("over");
    expect(moved.clips.some((c) => c.kind === "audio" && c.layer === "base")).toBe(true);
  });

  it("snaps equal-length unlinked A/V together", () => {
    const p = fromMedia(info);
    const un = tryToggleLink(p, p.clips[0].id);
    expect(un.ok).toBe(true);
    if (!un.ok) return;
    const p2 = { ...p, clips: un.clips };
    const a = p2.clips.find((c) => c.kind === "audio")!;
    a.timelineStart = 0.14;
    expect(snapStart(p2, a, 0.14, 0.08)).toBeCloseTo(0);
  });

  it("unlink then independent", () => {
    const p = fromMedia(info);
    const r = tryToggleLink(p, p.clips[0].id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips.every((c) => c.linkGroup === null)).toBe(true);
    const v = r.clips.find((c) => c.kind === "video")!;
    const a = r.clips.find((c) => c.kind === "audio")!;
    const linked = tryLinkPair({ ...p, clips: r.clips }, v.id, a.id);
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.clips.find((c) => c.id === v.id)?.linkGroup).toBe(linked.clips.find((c) => c.id === a.id)?.linkGroup);
  });

  it("drop second file becomes overlay at playhead", () => {
    const p = fromMedia(info);
    const extra: MediaInfo = { ...info, path: "C:/b.mp4", duration: 3, hasAudio: true };
    const r = tryAddOverlayFromMedia(p, extra, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const overV = r.clips.find((c) => c.kind === "video" && c.layer === "over");
    expect(overV?.timelineStart).toBe(2);
    expect(overV?.sourcePath).toBe("C:/b.mp4");
    expect(overV?.sourceEnd).toBe(3);
    expect(r.clips.filter((c) => c.layer === "over")).toHaveLength(2);
    const at = mapTimelineToSource({ ...p, clips: r.clips }, 2.5);
    expect(at?.clip.sourcePath).toBe("C:/b.mp4");
    const again = tryAddOverlayFromMedia({ ...p, clips: r.clips }, { ...extra, path: "C:/c.mp4", duration: 2 }, 6);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.clips.filter((c) => c.layer === "over" && c.kind === "video")).toHaveLength(2);
  });

  it("overlay dropped onto overlay splits the existing one", () => {
    const p = fromMedia(info);
    const first = tryAddOverlayFromMedia(p, { ...info, path: "C:/b.mp4", duration: 6 }, 0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const p2 = { ...p, clips: first.clips };
    const second = tryAddOverlayFromMedia(p2, { ...info, path: "C:/c.mp4", duration: 2, hasAudio: false }, 2);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const overV = second.clips.filter((c) => c.kind === "video" && c.layer === "over").sort((a, b) => a.timelineStart - b.timelineStart);
    expect(overV).toHaveLength(3);
    expect(overV[0].sourcePath).toBe("C:/b.mp4");
    expect(overV[0].sourceEnd).toBeCloseTo(2);
    expect(overV[1].sourcePath).toBe("C:/c.mp4");
    expect(overV[1].timelineStart).toBeCloseTo(2);
    expect(overV[2].timelineStart).toBeCloseTo(4);
    expect(overV[2].sourcePath).toBe("C:/b.mp4");
  });

  it("moving a base clip onto another base clip promotes it to overlay", () => {
    const p = fromMedia(info);
    const cut = trySlice(p, 4);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const p2 = { ...p, clips: cut.clips };
    const left = p2.clips.find((c) => c.kind === "video" && c.timelineStart === 0)!;
    const moved = tryMove(p2, left.id, 3);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const me = moved.clips.find((c) => c.id === left.id) ?? moved.clips.find((c) => c.kind === "video" && c.layer === "over");
    expect(me?.layer).toBe("over");
    expect(moved.clips.filter((c) => c.kind === "video" && c.layer === "base").length).toBeGreaterThan(0);
    const over = moved.clips.find((c) => c.kind === "video" && c.layer === "over")!;
    const p3 = { ...p2, clips: moved.clips };
    const tucked = tryTrim(p3, over.id, "right", over.sourceStart + 0.4);
    expect(tucked.ok).toBe(true);
    if (!tucked.ok) return;
    const after = tucked.clips.find((c) => c.id === over.id) ?? tucked.clips.find((c) => c.kind === "video" && Math.abs(c.timelineStart - over.timelineStart) < 0.01);
    expect(after?.layer).toBe("base");
  });

  it("flatten uses overlay over base, then the clip underneath", () => {
    const p = fromMedia(info);
    p.clips.push({
      id: "over",
      kind: "video",
      layer: "over",
      timelineStart: 4,
      sourceStart: 7,
      sourceEnd: 9,
      linkGroup: null,
    });
    const atOverlay = mapTimelineToSource(p, 5);
    expect(atOverlay?.clip.layer).toBe("over");
    expect(atOverlay?.source).toBeCloseTo(8);
    const under = mapTimelineToSource(p, 6);
    expect(under?.clip.layer).toBe("base");
    expect(under?.source).toBeCloseTo(6);

    const flat = flattenKind(p, "video").filter((s) => !s.gap);
    expect(flat[0]).toMatchObject({ sourceStart: 0, sourceEnd: 4 });
    expect(flat[1]).toMatchObject({ sourceStart: 7, sourceEnd: 9 });
    expect(flat[2]).toMatchObject({ sourceStart: 6, sourceEnd: 10 });
  });

  it("lift range punches a hole and keeps sides", () => {
    const p = fromMedia(info);
    const r = tryLiftRange(p, "video", 3, 6);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const vids = r.clips.filter((c) => c.kind === "video").sort((a, b) => a.timelineStart - b.timelineStart);
    expect(vids).toHaveLength(2);
    expect(vids[0].sourceEnd).toBeCloseTo(3);
    expect(vids[1].timelineStart).toBeCloseTo(6);
    const auds = r.clips.filter((c) => c.kind === "audio");
    expect(auds).toHaveLength(2);
  });

  it("lift range refuses empty or tiny selections", () => {
    const p = fromMedia(info);
    expect(tryLiftRange(p, "video", 4, 4.01).ok).toBe(false);
    expect(tryLiftRange(p, "video", 20, 22).ok).toBe(false);
  });

  it("lift unlinked audio does not punch video", () => {
    const p = fromMedia(info);
    const unlinked = tryToggleLink(p, p.clips[0].id);
    if (!unlinked.ok) throw new Error("unlink");
    const next = { ...p, clips: unlinked.clips };
    const r = tryLiftRange(next, "audio", 1, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips.filter((c) => c.kind === "video")).toHaveLength(1);
    expect(r.clips.filter((c) => c.kind === "audio")).toHaveLength(2);
  });

  it("box select on video includes linked audio", () => {
    const p = fromMedia(info);
    const spans = collectLaneSpans(p, "video", 1, 4);
    expect(spans.some((s) => p.clips.find((c) => c.id === s.clipId)?.kind === "video")).toBe(true);
    expect(spans.some((s) => p.clips.find((c) => c.id === s.clipId)?.kind === "audio")).toBe(true);
  });

  it("box select on unlinked audio does not include video", () => {
    const p = fromMedia(info);
    const un = tryToggleLink(p, p.clips[0].id);
    if (!un.ok) throw new Error("unlink");
    const p2 = { ...p, clips: un.clips };
    const spans = collectLaneSpans(p2, "audio", 1, 4);
    expect(spans.every((s) => p2.clips.find((c) => c.id === s.clipId)?.kind === "audio")).toBe(true);
  });

  it("extracting a mid span splits the clip", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    const ex = extractSpans(p, [{ clipId: v.id, start: 2, end: 5 }]);
    const vids = ex.clips.filter((c) => c.kind === "video").sort((a, b) => a.timelineStart - b.timelineStart);
    expect(vids.length).toBe(3);
    expect(vids[1].timelineStart).toBeCloseTo(2);
    expect(ex.ids).toHaveLength(1);
  });

  it("moving a partial extract leaves leftovers", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    const ex = extractSpans(p, [{ clipId: v.id, start: 2, end: 5 }]);
    const mid = ex.clips.find((c) => c.id === ex.ids[0])!;
    const moved = tryMoveIds({ ...p, clips: ex.clips }, new Set(ex.ids), 1);
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const m = moved.clips.find((c) => c.id === mid.id)!;
    expect(m.timelineStart).toBeCloseTo(3);
    expect(moved.clips.filter((c) => c.kind === "video").length).toBeGreaterThanOrEqual(3);
  });

  it("motion keys interpolate and survive a slice", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    v.anim = [
      { id: "a", t: 0, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
      { id: "b", t: 4, x: 100, y: -20, scale: 2, scaleX: 2, scaleY: 2, rotation: 90 },
    ];
    expect(poseAt(v, 2).x).toBeCloseTo(50);
    expect(poseAt(v, 2).rotation).toBeCloseTo(45);
    const cut = trySlice(p, 2);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;
    const left = cut.clips.find((c) => c.kind === "video" && c.timelineStart === 0)!;
    const right = cut.clips.find((c) => c.kind === "video" && c.timelineStart > 1)!;
    expect(poseAt(left, 2).x).toBeCloseTo(50, 0);
    expect(poseAt(right, 2).x).toBeCloseTo(50, 0);
    expect(poseAt(right, 4).x).toBeCloseTo(100, 0);
    const trimmed = tryTrim({ ...p, clips: cut.clips }, left.id, "left", 1);
    expect(trimmed.ok).toBe(true);
    if (!trimmed.ok) return;
    const shifted = trimmed.clips.find((c) => c.id === left.id)!;
    expect(poseAt(shifted, shifted.timelineStart).x).toBeCloseTo(25, 0);
  });

  it("moving does not write the blended scale back onto a key", () => {
    const prev = { x: 0, y: 0, scale: 0.4, scaleX: 0.4, scaleY: 0.4, rotation: 10 };
    const blended = { x: 30, y: -8, scale: 0.9, scaleX: 0.9, scaleY: 0.9, rotation: 40 };
    const out = writeTransform(prev, blended, { pan: true });
    expect(out.x).toBe(30);
    expect(out.y).toBe(-8);
    expect(out.scale).toBe(0.4);
    expect(out.rotation).toBe(10);
  });

  it("a motion key can drop a channel or hold instead of blending", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    v.transform = { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 };
    v.anim = [
      { id: "a", t: 0, x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0 },
      { id: "b", t: 4, x: 80, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 40, channels: { pan: false, blend: false } },
    ];
    expect(poseAt(v, 2).x).toBeCloseTo(0);
    expect(poseAt(v, 2).rotation).toBeCloseTo(0);
    expect(poseAt(v, 4).x).toBeCloseTo(0);
    expect(poseAt(v, 4).rotation).toBeCloseTo(40);
  });

  it("flatten keeps timeline holes as gaps", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    v.timelineStart = 2;
    const flat = flattenKind(p, "video");
    expect(flat[0]).toEqual({ gap: true, duration: 2 });
    expect(flat.some((r) => !r.gap)).toBe(true);
  });
});

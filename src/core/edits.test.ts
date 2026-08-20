import { describe, expect, it } from "vitest";
import { fromMedia, flattenKind, mapTimelineToSource, timelineDuration } from "./project";
import { tryAddOverlayFromMedia, tryDelete, tryLiftRange, trySlice, tryToggleLink } from "./edits";
import type { MediaInfo } from "./types";

const info: MediaInfo = {
  path: "C:/x.mp4",
  duration: 10,
  hasAudio: true,
  keyframeTimes: [0, 2, 4],
};

describe("timeline model", () => {
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

  it("unlink then independent", () => {
    const p = fromMedia(info);
    const r = tryToggleLink(p, p.clips[0].id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clips.every((c) => c.linkGroup === null)).toBe(true);
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

  it("flatten keeps timeline holes as gaps", () => {
    const p = fromMedia(info);
    const v = p.clips.find((c) => c.kind === "video")!;
    v.timelineStart = 2;
    const flat = flattenKind(p, "video");
    expect(flat[0]).toEqual({ gap: true, duration: 2 });
    expect(flat.some((r) => !r.gap)).toBe(true);
  });
});

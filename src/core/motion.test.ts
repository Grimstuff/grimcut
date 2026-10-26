import { describe, expect, it } from "vitest";
import { motionTarget, poseAt, stepKey } from "./canvas";
import { tryAddOverlayFromMedia, trySlice } from "./edits";
import { flattenCanvas, fromMedia } from "./project";
import type { AnimKey, Clip, MediaInfo, VideoProject } from "./types";

const info: MediaInfo = { path: "C:/base.mp4", duration: 10, hasAudio: false, keyframeTimes: [] };
const overInfo: MediaInfo = { path: "C:/over.mp4", duration: 4, hasAudio: false, keyframeTimes: [] };

function key(t: number, x: number, extra: Partial<AnimKey> = {}): AnimKey {
  return { id: `k${t}`, t, x, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, ...extra };
}

function withOverlay(): { p: VideoProject; base: Clip; over: Clip } {
  const r = tryAddOverlayFromMedia(fromMedia(info), overInfo, 2);
  if (!r.ok) throw new Error(r.error);
  const p = { ...fromMedia(info), clips: r.clips };
  return {
    p,
    base: p.clips.find((c) => c.layer === "base")!,
    over: p.clips.find((c) => c.layer === "over")!,
  };
}

describe("motion keys on both layers", () => {
  it("key button targets the overlay where it covers, the main track elsewhere", () => {
    const { p, base, over } = withOverlay();
    expect(motionTarget(p.clips, 3, null)?.id).toBe(over.id);
    expect(motionTarget(p.clips, 8, null)?.id).toBe(base.id);
    expect(motionTarget(p.clips, 3, base.id)?.id).toBe(base.id);
  });

  it("overlay keys animate the overlay layer in the composite", () => {
    const { p, over } = withOverlay();
    const anim = [key(0, 0), key(2, 200)];
    const clips = p.clips.map((c) => (c.id === over.id ? { ...c, anim } : c));
    const animated = { ...p, clips };
    expect(poseAt(clips.find((c) => c.id === over.id)!, 3).x).toBeCloseTo(100);
    const slices = flattenCanvas(animated, info);
    const at3 = slices.reduce<{ t: number; hit: (typeof slices)[number] | null }>(
      (acc, s) => {
        const hit = acc.t <= 3 && acc.t + s.duration > 3 ? s : acc.hit;
        return { t: acc.t + s.duration, hit };
      },
      { t: 0, hit: null },
    ).hit!;
    expect(at3.layers).toHaveLength(2);
    expect(at3.layers[1].x).toBeGreaterThan(80);
    expect(at3.layers[1].x).toBeLessThan(120);
  });

  it("slicing an animated overlay keeps the pose continuous on both halves", () => {
    const { p, over } = withOverlay();
    const anim = [key(0, 0), key(4, 400)];
    const animated = { ...p, clips: p.clips.map((c) => (c.id === over.id ? { ...c, anim } : c)) };
    const r = trySlice(animated, 4, over.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const halves = r.clips.filter((c) => c.layer === "over").sort((a, b) => a.timelineStart - b.timelineStart);
    expect(halves).toHaveLength(2);
    expect(poseAt(halves[0], 3.9).x).toBeCloseTo(190, 0);
    expect(poseAt(halves[1], 4).x).toBeCloseTo(200, 0);
    expect(poseAt(halves[1], 6).x).toBeCloseTo(400, 0);
  });

  it("stepKey walks keys in time order from a timeline time", () => {
    const c = { ...withOverlay().over, anim: [key(3, 0), key(1, 0), key(2, 0)] };
    expect(stepKey(c, 2 + 2, 1)?.t).toBe(3);
    expect(stepKey(c, 2 + 2, -1)?.t).toBe(1);
    expect(stepKey(c, 2 + 3, 1)).toBeNull();
    expect(stepKey(c, 2 + 1, -1)).toBeNull();
  });
});

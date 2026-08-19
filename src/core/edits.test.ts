import { describe, expect, it } from "vitest";
import { fromMedia, timelineDuration } from "./project";
import { tryCut, tryDelete } from "./edits";
import { canStreamCopyAllClips } from "./keyframes";
import type { MediaInfo } from "./types";

const info: MediaInfo = {
  path: "C:/x.mp4",
  duration: 10,
  hasAudio: true,
  keyframeTimes: [0, 2, 4, 6, 8],
};

describe("edits", () => {
  it("cuts into two touching clips", () => {
    const p = fromMedia(info);
    const r = tryCut(p, 4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.segments).toHaveLength(2);
    expect(r.segments[0].sourceEnd).toBe(4);
    expect(r.segments[1].timelineStart).toBe(4);
  });

  it("delete leaves a gap (does not ripple)", () => {
    const p = fromMedia(info);
    const c1 = tryCut(p, 3);
    if (!c1.ok) throw new Error("cut1");
    p.segments = c1.segments;
    const c2 = tryCut(p, 7);
    if (!c2.ok) throw new Error("cut2");
    p.segments = c2.segments;
    const mid = p.segments[1].id;
    const d = tryDelete(p, mid);
    if (!d.ok) throw new Error(d.error);
    expect(d.segments).toHaveLength(2);
    expect(d.segments[1].timelineStart).toBe(7);
    expect(timelineDuration({ ...p, segments: d.segments })).toBe(10);
  });

  it("stream-copy only when starts are on keyframes", () => {
    expect(canStreamCopyAllClips([{ id: "a", timelineStart: 0, sourceStart: 0, sourceEnd: 2 }], [0, 2], 30)).toBe(true);
    expect(canStreamCopyAllClips([{ id: "a", timelineStart: 0, sourceStart: 1, sourceEnd: 2 }], [0, 2], 30)).toBe(false);
  });
});

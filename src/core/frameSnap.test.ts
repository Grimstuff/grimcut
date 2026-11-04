import { describe, expect, it } from "vitest";
import { fromMedia, snapToFrame } from "./project";
import type { MediaInfo } from "./types";

const info: MediaInfo = { path: "C:/x.mp4", duration: 10, hasAudio: true, keyframeTimes: [0], frameRate: 25 };

describe("snapToFrame", () => {
  it("rounds a seek to the nearest frame start", () => {
    const p = fromMedia(info);
    expect(snapToFrame(p, 1.013, () => 25)).toBeCloseTo(1.0, 9);
    expect(snapToFrame(p, 1.027, () => 25)).toBeCloseTo(1.04, 9);
  });

  it("follows the source frame grid of a clip placed off-grid", () => {
    const p = fromMedia(info);
    const c = p.clips.find((x) => x.kind === "video")!;
    c.sourceStart = 2;
    c.sourceEnd = 6;
    c.timelineStart = 0.01;
    const t = snapToFrame(p, 1.0, () => 25);
    const src = c.sourceStart + (t - c.timelineStart);
    expect(Math.abs(src * 25 - Math.round(src * 25))).toBeLessThan(1e-6);
    expect(Math.abs(t - 1.0)).toBeLessThanOrEqual(0.02 + 1e-9);
  });

  it("falls back to 30 fps when the rate is unknown", () => {
    const p = fromMedia(info);
    expect(snapToFrame(p, 0.05, () => null)).toBeCloseTo(2 / 30, 9);
  });
});

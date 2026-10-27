import { describe, expect, it } from "vitest";
import { displaySize } from "./ffmpeg";

describe("displaySize", () => {
  it("swaps width and height for a phone video rotated by the display matrix", () => {
    const s = { width: 1280, height: 720, side_data_list: [{ rotation: -90 }] };
    expect(displaySize(s)).toEqual({ width: 720, height: 1280 });
  });

  it("reads the legacy rotate tag", () => {
    expect(displaySize({ width: 1920, height: 1080, tags: { rotate: "270" } })).toEqual({ width: 1080, height: 1920 });
  });

  it("keeps the size for upright and upside-down video", () => {
    expect(displaySize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
    expect(displaySize({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] })).toEqual({ width: 1920, height: 1080 });
  });
});

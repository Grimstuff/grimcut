import { describe, expect, it } from "vitest";
import { displaySize, gifArgs } from "./ffmpeg";

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

describe("gifArgs", () => {
  it("builds a palette GIF of the clip span with no audio, looping forever", () => {
    const a = gifArgs("C:/in.mp4", 2, 5.5, "C:/out.gif");
    expect(a.slice(a.indexOf("-ss"), a.indexOf("-ss") + 4)).toEqual(["-ss", "2", "-t", "3.5"]);
    const chain = a[a.indexOf("-filter_complex") + 1];
    expect(chain).toContain("palettegen");
    expect(chain).toContain("paletteuse");
    expect(chain).toContain("fps=15");
    expect(a).toContain("-an");
    expect(a.slice(-3)).toEqual(["-loop", "0", "C:/out.gif"]);
  });
});

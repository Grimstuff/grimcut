import { describe, expect, it } from "vitest";
import { averageHex, despill, guessScreenColor, keyAlpha, rgbToUv, spillChannel } from "./chromakey";
import { clipKey, DEFAULT_KEY, type Clip } from "./types";

function frame(px: [number, number, number][]) {
  const d = new Uint8ClampedArray(px.length * 4);
  px.forEach(([r, g, b], i) => d.set([r, g, b, 255], i * 4));
  return d;
}

describe("chroma key math", () => {
  it("matches FFmpeg's full-range BT.601 key chroma", () => {
    const [u, v] = rgbToUv(0, 255, 0);
    expect(u).toBeCloseTo(43.53, 1);
    expect(v).toBeCloseTo(21.23, 1);
  });

  it("ramps alpha between similarity and similarity + blend", () => {
    expect(keyAlpha(0.05, { similarity: 0.1, blend: 0.1 })).toBe(0);
    expect(keyAlpha(0.15, { similarity: 0.1, blend: 0.1 })).toBeCloseTo(0.5);
    expect(keyAlpha(0.3, { similarity: 0.1, blend: 0.1 })).toBe(1);
    expect(keyAlpha(0.11, { similarity: 0.1, blend: 0 })).toBe(1);
  });

  it("despills toward the mean of the other channels", () => {
    expect(despill(100, 200, 100, "#00ff00", 1)).toEqual([100, 100, 100]);
    expect(despill(100, 200, 100, "#00ff00", 0.5)).toEqual([100, 150, 100]);
    expect(despill(100, 100, 220, "#1030e0", 1)).toEqual([100, 100, 100]);
    expect(spillChannel("#d02020")).toBeNull();
  });

  it("finds the screen color and ignores frames without one", () => {
    const greenScreen = frame([...Array(80).fill([20, 180, 60]), ...Array(20).fill([200, 150, 120])]);
    expect(guessScreenColor(greenScreen)).toBe("#14b43c");
    expect(guessScreenColor(frame(Array(100).fill([120, 120, 120])))).toBeNull();
    expect(averageHex(frame([[0, 0, 0], [255, 255, 255]]))).toBe("#808080");
  });

  it("only video clips carry a key, filled with defaults", () => {
    const base: Clip = { id: "a", kind: "video", layer: "over", timelineStart: 0, sourceStart: 0, sourceEnd: 1, linkGroup: null };
    expect(clipKey(base)).toBeNull();
    const keyed = { ...base, effects: [{ id: "k", kind: "key" as const, amount: 0, key: { ...DEFAULT_KEY, color: "#0000ff" } }] };
    expect(clipKey(keyed)?.color).toBe("#0000ff");
    expect(clipKey({ ...keyed, kind: "text" })).toBeNull();
  });
});

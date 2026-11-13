import type { KeyParams } from "./types";

/**
 * Chroma key math shared by the preview shader and the FFmpeg export.
 *
 * The export converts each frame to BT.601 full-range YUV before `chromakey`, because that is
 * the formula FFmpeg uses for the key color itself; the preview converts the decoded RGB the
 * same way. Distance is the mean of the 3×3 neighbourhood's chroma distances, then
 * `similarity` / `blend` make the ramp.
 */
export function keyRgb(hex: string): [number, number, number] {
  const t = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(t)) return [0, 177, 64];
  return [parseInt(t.slice(0, 2), 16), parseInt(t.slice(2, 4), 16), parseInt(t.slice(4, 6), 16)];
}

/** BT.601 full-range chroma (0..255) of an 8-bit RGB color, as FFmpeg's chromakey key color. */
export function rgbToUv(r: number, g: number, b: number): [number, number] {
  const u = 128 + (-0.16874 * r - 0.33126 * g + 0.5 * b);
  const v = 128 + (0.5 * r - 0.41869 * g - 0.08131 * b);
  return [u, v];
}

/** Which channel the despill pulls down: green, blue, or none for other screen colors. */
export function spillChannel(hex: string): "green" | "blue" | null {
  const [r, g, b] = keyRgb(hex);
  if (g >= b && g > r) return "green";
  if (b > g && b > r) return "blue";
  return null;
}

/** Alpha for one pixel's mean chroma distance, exactly as FFmpeg's chromakey. */
export function keyAlpha(diff: number, p: Pick<KeyParams, "similarity" | "blend">): number {
  if (p.blend > 0.0001) return Math.max(0, Math.min(1, (diff - p.similarity) / p.blend));
  return diff > p.similarity ? 1 : 0;
}

/** FFmpeg despill (mix 0.5, expand 0): pull the screen channel toward the mean of the other two. */
export function despill(r: number, g: number, b: number, hex: string, amount: number): [number, number, number] {
  const ch = spillChannel(hex);
  if (!ch || amount <= 0) return [r, g, b];
  if (ch === "green") {
    const s = Math.max(0, g - (r * 0.5 + b * 0.5));
    return [r, Math.max(0, g - s * amount), b];
  }
  const s = Math.max(0, b - (r * 0.5 + g * 0.5));
  return [r, g, Math.max(0, b - s * amount)];
}

/**
 * Guess the screen color from a frame: the median of the dominant green- or blue-screen pixels.
 * Returns null when neither covers enough of the frame to be a screen.
 */
export function guessScreenColor(data: Uint8ClampedArray | Uint8Array): string | null {
  const greens: number[][] = [];
  const blues: number[][] = [];
  const n = Math.floor(data.length / 4);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    if (g - Math.max(r, b) > 28) greens.push([r, g, b]);
    else if (b - Math.max(r, g) > 28) blues.push([r, g, b]);
  }
  const pick = greens.length >= blues.length ? greens : blues;
  if (pick.length < n * 0.08) return null;
  const med = (k: number) => {
    const v = pick.map((p) => p[k]).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  return "#" + [med(0), med(1), med(2)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Average color of a w×h RGBA block. */
export function averageHex(data: Uint8ClampedArray | Uint8Array): string {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = Math.max(1, Math.floor(data.length / 4));
  for (let i = 0; i < n; i++) {
    r += data[i * 4];
    g += data[i * 4 + 1];
    b += data[i * 4 + 2];
  }
  return "#" + [r / n, g / n, b / n].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
}

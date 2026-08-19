import type { Clip } from "./types";

export function toleranceFor(frameRate?: number | null): number {
  if (frameRate && frameRate > 1 && frameRate < 240) return 0.6 / frameRate;
  return 0.042;
}

export function nearestKeyframe(time: number, keyframes: number[]): number | null {
  if (keyframes.length === 0) return time <= 0.02 ? 0 : null;
  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keyframes[mid];
    if (k === time) return k;
    if (k < time) lo = mid + 1;
    else hi = mid - 1;
  }
  const a = hi >= 0 ? keyframes[hi] : null;
  const b = lo < keyframes.length ? keyframes[lo] : null;
  if (a == null) return b;
  if (b == null) return a;
  return Math.abs(a - time) <= Math.abs(b - time) ? a : b;
}

/** Weak snap: only if within threshold seconds. */
export function snapToKeyframe(time: number, keyframes: number[], threshold: number): number {
  const n = nearestKeyframe(time, keyframes);
  if (n == null) return time;
  return Math.abs(n - time) <= threshold ? n : time;
}

export function isOnKeyframe(time: number, keyframes: number[], tolerance: number): boolean {
  if (keyframes.length === 0) return false;
  if (time <= tolerance) return true;
  let lo = 0;
  let hi = keyframes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = keyframes[mid];
    if (Math.abs(k - time) <= tolerance) return true;
    if (k < time) lo = mid + 1;
    else hi = mid - 1;
  }
  if (lo < keyframes.length && Math.abs(keyframes[lo] - time) <= tolerance) return true;
  if (lo > 0 && Math.abs(keyframes[lo - 1] - time) <= tolerance) return true;
  return false;
}

export function canStreamCopyAllClips(
  clips: Clip[],
  keyframes: number[],
  frameRate?: number | null,
): boolean {
  if (keyframes.length === 0) return false;
  const tol = toleranceFor(frameRate);
  return clips.every((c) => isOnKeyframe(c.sourceStart, keyframes, tol));
}

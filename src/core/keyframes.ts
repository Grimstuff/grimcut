import type { ClipSegment } from "./types";

export function toleranceFor(frameRate?: number | null): number {
  if (frameRate && frameRate > 1 && frameRate < 240) return 0.6 / frameRate;
  return 0.042;
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
  clips: ClipSegment[],
  keyframes: number[],
  frameRate?: number | null,
): boolean {
  if (keyframes.length === 0) return false;
  const tol = toleranceFor(frameRate);
  return clips.every((c) => isOnKeyframe(c.sourceStart, keyframes, tol));
}

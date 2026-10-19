import { describe, expect, it, vi } from "vitest";

vi.mock("./previewSound", () => ({
  soundPrime: async () => {},
  soundSet: () => {},
  soundStop: () => {},
  soundUnload: () => {},
}));

import { tryAddOverlayFromMedia } from "../core/edits";
import { fromMedia } from "../core/project";
import type { MediaInfo } from "../core/types";
import { useEditor } from "../store/editorStore";
import { setOverlayVideo, syncPreviewToPlayhead } from "./playbackClock";

/** Just enough of a <video> for the preview clock. Reloading drops the frame back to 0 like a real element. */
function fakeVideo() {
  let src: string | null = null;
  return {
    dataset: {} as Record<string, string>,
    muted: false,
    volume: 1,
    paused: true,
    seeking: false,
    error: null,
    readyState: 4,
    currentTime: 0,
    isConnected: true,
    pause() {},
    addEventListener() {},
    getAttribute: (n: string) => (n === "src" ? src : null),
    removeAttribute(n: string) {
      if (n === "src") src = null;
    },
    load() {
      this.currentTime = 0;
    },
    set src(v: string) {
      src = v;
      this.currentTime = 0;
    },
    get src() {
      return src ?? "";
    },
  };
}

const base: MediaInfo = { path: "C:/base.mp4", duration: 10, hasAudio: false, keyframeTimes: [] };
const over: MediaInfo = { path: "C:/slime.webm", duration: 4, hasAudio: false, keyframeTimes: [] };

describe("overlay preview picture", () => {
  it("re-seeks the overlay after its video reloads, even mid-drag", () => {
    const r = tryAddOverlayFromMedia(fromMedia(base), over, 1);
    if (!r.ok) throw new Error(r.error);
    useEditor.setState({
      project: { ...fromMedia(base), clips: r.clips },
      playhead: 2,
      playing: false,
      scrubPreview: null,
      previewUrl: "asset://base",
      previewByPath: { [base.path]: "asset://base", [over.path]: "asset://slime" },
    });
    const el = fakeVideo();
    setOverlayVideo(el as unknown as HTMLVideoElement);

    syncPreviewToPlayhead();
    expect(el.currentTime).toBeCloseTo(1);

    // A move/resize re-renders the preview; the element reloads and lands on frame 0.
    el.removeAttribute("src");
    el.load();
    syncPreviewToPlayhead();
    expect(el.getAttribute("src")).toBe("asset://slime");
    expect(el.currentTime).toBeCloseTo(1);
  });
});

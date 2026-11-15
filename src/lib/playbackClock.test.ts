import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { markVideoSeekDone, noteUserSeek, setOverlayVideo, setPreviewVideo, syncPreviewToPlayhead, timelineOnClip } from "./playbackClock";

/** Just enough of a <video> for the preview clock. Reloading drops the frame back to 0 like a real element. */
function fakeVideo() {
  let src: string | null = null;
  const listeners: Record<string, (() => void)[]> = {};
  return {
    listeners,
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
    addEventListener(name: string, fn: () => void) {
      (listeners[name] ??= []).push(fn);
    },
    fire(name: string) {
      for (const fn of listeners[name] ?? []) fn();
    },
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

describe("playhead from the preview picture", () => {
  // The same source second sits on the timeline twice: 0-10 at 0, and 0-10 again at 20.
  const twice = () => {
    const p = fromMedia(base);
    const a = p.clips[0];
    return { ...p, clips: [a, { ...a, id: "again", timelineStart: 20 }] };
  };

  it("reads the picture against the clip under the playhead, not the first one", () => {
    const p = twice();
    expect(timelineOnClip(p, 4, 23.9)).toBeCloseTo(24);
    expect(timelineOnClip(p, 4, 3.9)).toBeCloseTo(4);
  });

  it("ignores a picture of another file", () => {
    const p = twice();
    p.clips[1] = { ...p.clips[1], sourcePath: "C:/other.mp4" };
    expect(timelineOnClip(p, 4, 3.9, base.path)).toBeCloseTo(4);
    expect(timelineOnClip(p, 4, 23.9, base.path)).toBeNull();
    expect(timelineOnClip(p, 4, 23.9, "C:/other.mp4")).toBeCloseTo(24);
  });

  it("leaves the playhead alone when a paused seek reports its time", () => {
    useEditor.setState({ project: twice(), playhead: 24, playing: false, scrubPreview: null, previewUrl: "asset://base", previewByPath: { [base.path]: "asset://base" } });
    const el = fakeVideo();
    setPreviewVideo(el as unknown as HTMLVideoElement);
    el.currentTime = 4;
    el.fire("timeupdate");
    expect(useEditor.getState().playhead).toBeCloseTo(24);
  });
});

describe("paused preview picture", () => {
  const fps60: MediaInfo = { ...base, frameRate: 60 };
  const open = (playhead: number) => {
    useEditor.setState({
      project: fromMedia(fps60),
      playhead,
      playing: false,
      scrubPreview: null,
      previewUrl: "asset://base",
      previewByPath: { [base.path]: "asset://base" },
    });
    const el = fakeVideo();
    setPreviewVideo(el as unknown as HTMLVideoElement);
    return el;
  };
  const step = (t: number) => {
    useEditor.setState({ playhead: t });
    noteUserSeek();
    syncPreviewToPlayhead();
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.advanceTimersByTime(1000);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("lands on every single-frame step at 60 fps, not every third one", () => {
    const el = open(3.7);
    syncPreviewToPlayhead();
    for (let k = 1; k <= 4; k++) {
      vi.advanceTimersByTime(200);
      step(3.7 - k / 60);
      // Just inside the frame that starts at the playhead, so that frame is the one shown.
      expect(el.currentTime - (3.7 - k / 60)).toBeGreaterThan(0);
      expect(el.currentTime - (3.7 - k / 60)).toBeLessThan(1 / 120);
    }
  });

  it("coalesces fast steps and lands on the last one once they stop", () => {
    const el = open(2);
    syncPreviewToPlayhead();
    let seeks = 0;
    let t = el.currentTime;
    Object.defineProperty(el, "currentTime", {
      get: () => t,
      set: (v: number) => {
        seeks++;
        t = v;
      },
    });
    for (let k = 1; k <= 5; k++) {
      vi.advanceTimersByTime(30);
      step(2 + k / 60);
    }
    expect(seeks).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(200);
    expect(t - (2 + 5 / 60)).toBeGreaterThan(0);
    expect(t - (2 + 5 / 60)).toBeLessThan(1 / 120);
  });

  it("does not keep re-seeking when the element reports a slightly different time", () => {
    const el = open(2);
    let seeks = 0;
    Object.defineProperty(el, "currentTime", {
      get: () => 1.99,
      // Loading a src resets the time to 0; only count real seeks.
      set: (v: number) => {
        if (v > 0) seeks++;
      },
    });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(200);
      markVideoSeekDone();
      syncPreviewToPlayhead();
    }
    expect(seeks).toBe(1);
  });

  it("catches up on a step that arrived while the last seek was running", () => {
    const el = open(2);
    syncPreviewToPlayhead();
    el.seeking = true;
    vi.advanceTimersByTime(200);
    step(2 + 1 / 60);
    expect(el.currentTime).toBeLessThan(2 + 1 / 120);
    el.seeking = false;
    markVideoSeekDone();
    vi.advanceTimersByTime(200);
    expect(el.currentTime).toBeGreaterThan(2 + 1 / 60);
  });
});

describe("playing past a pasted clip", () => {
  // Source 5-7 pasted at the start, then the rest of the video (source 0-10) after it.
  const pasted = () => {
    const p = fromMedia(base);
    const a = p.clips[0];
    return {
      ...p,
      clips: [
        { ...a, id: "paste", timelineStart: 0, sourceStart: 5, sourceEnd: 7, linkGroup: null },
        { ...a, id: "rest", timelineStart: 2, sourceStart: 0, sourceEnd: 10, linkGroup: null },
      ],
    };
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    vi.advanceTimersByTime(1000);
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("moves on to the next clip instead of jumping to where the paste came from", () => {
    useEditor.setState({ project: pasted(), playhead: 1.98, playing: true, scrubPreview: null, previewUrl: "asset://base", previewByPath: { [base.path]: "asset://base" } });
    const el = fakeVideo();
    setPreviewVideo(el as unknown as HTMLVideoElement);
    el.dataset.mediaPath = base.path;
    el.paused = false;
    el.currentTime = 7.03;
    el.fire("timeupdate");
    // Source 7.03 is also at 9.03 in the next clip; the playhead must not go there.
    expect(useEditor.getState().playhead).toBeCloseTo(2);

    // The next clip starts at source 0, so the playing picture is seeked there.
    syncPreviewToPlayhead();
    expect(el.currentTime).toBeCloseTo(0);
  });

  it("ignores the old picture while the seek to the next clip is running", () => {
    useEditor.setState({ project: pasted(), playhead: 2, playing: true, scrubPreview: null, previewUrl: "asset://base", previewByPath: { [base.path]: "asset://base" } });
    const el = fakeVideo();
    setPreviewVideo(el as unknown as HTMLVideoElement);
    el.dataset.mediaPath = base.path;
    el.paused = false;
    el.currentTime = 7.05;
    el.fire("timeupdate");
    expect(useEditor.getState().playhead).toBeCloseTo(2);
  });
});

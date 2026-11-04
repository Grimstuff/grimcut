import { describe, expect, it } from "vitest";
import { fromMedia } from "../core/project";
import type { MediaInfo } from "../core/types";
import { MAX_ZOOM, useEditor } from "./editorStore";

const media: MediaInfo = { path: "C:/k.mp4", duration: 10, hasAudio: false, keyframeTimes: [0, 2, 4, 6, 8], frameRate: 25 };

function cutAt(t: number, zoom: number, how: { exact?: boolean; stepped?: boolean } = {}): number[] {
  useEditor.setState({ project: fromMedia(media), media, playhead: t, exactPlayhead: !!how.stepped, zoom, range: null, selectedId: null });
  useEditor.getState().slice(undefined, undefined, { exact: how.exact });
  return useEditor
    .getState()
    .project!.clips.filter((c) => c.kind === "video")
    .map((c) => c.timelineStart)
    .sort((a, b) => a - b);
}

describe("cutting near a keyframe", () => {
  it("snaps to the keyframe when not fully zoomed in", () => {
    expect(cutAt(2.08, 40)[1]).toBeCloseTo(2, 9);
  });

  it("cuts on the exact playhead frame at full zoom", () => {
    expect(cutAt(2.08, MAX_ZOOM)[1]).toBeCloseTo(2.08, 9);
  });

  it("cuts exact with Alt (exact option)", () => {
    expect(cutAt(2.08, 40, { exact: true })[1]).toBeCloseTo(2.08, 9);
  });

  it("cuts exact after frame-stepping onto the frame", () => {
    expect(cutAt(2.08, 40, { stepped: true })[1]).toBeCloseTo(2.08, 9);
  });

  it("a mouse seek clears the frame-stepped flag", () => {
    useEditor.setState({ project: fromMedia(media), media, exactPlayhead: true });
    useEditor.getState().setPlayhead(2.08);
    expect(useEditor.getState().exactPlayhead).toBe(false);
  });
});

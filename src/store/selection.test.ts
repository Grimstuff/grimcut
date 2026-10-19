import { describe, expect, it } from "vitest";
import { motionTarget } from "../core/canvas";
import { tryAddOverlayFromMedia } from "../core/edits";
import { fromMedia } from "../core/project";
import type { MediaInfo } from "../core/types";
import { useEditor } from "./editorStore";

const base: MediaInfo = { path: "C:/base.mp4", duration: 10, hasAudio: false, keyframeTimes: [] };
const over: MediaInfo = { path: "C:/over.webm", duration: 4, hasAudio: false, keyframeTimes: [] };

function load() {
  const r = tryAddOverlayFromMedia(fromMedia(base), over, 2);
  if (!r.ok) throw new Error(r.error);
  const project = { ...fromMedia(base), clips: r.clips };
  useEditor.setState({ project, playhead: 0, selectedId: null, selectedAnimId: null });
  return {
    baseClip: project.clips.find((c) => c.layer === "base")!,
    overClip: project.clips.find((c) => c.layer === "over")!,
  };
}

describe("selection while seeking", () => {
  it("seeking over an overlay keeps a selected main-track clip selected and keyed", () => {
    const { baseClip } = load();
    const st = useEditor.getState();
    st.select(baseClip.id);
    for (const t of [1, 2.5, 4, 5.9]) {
      st.setPlayhead(t);
      expect(useEditor.getState().selectedId).toBe(baseClip.id);
    }
    const s = useEditor.getState();
    expect(motionTarget(s.project!.clips, s.playhead, s.selectedId)?.id).toBe(baseClip.id);
  });

  it("with nothing picked, the clip on top follows the playhead", () => {
    const { baseClip, overClip } = load();
    const st = useEditor.getState();
    st.setPlayhead(3);
    expect(useEditor.getState().selectedId).toBe(overClip.id);
    st.setPlayhead(8);
    expect(useEditor.getState().selectedId).toBe(baseClip.id);
  });
});

import { describe, expect, it } from "vitest";
import { collectLaneSpans } from "../core/edits";
import { fromMedia } from "../core/project";
import type { MediaInfo } from "../core/types";
import { useEditor } from "./editorStore";

const info: MediaInfo = { path: "C:/x.mp4", duration: 10, hasAudio: true, keyframeTimes: [] };

function load() {
  const project = fromMedia(info);
  useEditor.setState({
    project,
    playhead: 0,
    selectedId: null,
    selectedAnimId: null,
    clipSel: [],
    range: null,
    clipboard: null,
    collapseBlank: false,
  });
  return project;
}

describe("copy and paste", () => {
  it("copies a timeline selection with linked audio and pastes it more than once", () => {
    const p = load();
    const st = useEditor.getState();
    st.setClipSel(collectLaneSpans(p, "video", 2, 4));
    st.copyRange();
    expect(useEditor.getState().clipboard?.clips).toHaveLength(2);

    st.setPlayhead(10);
    st.paste();
    let s = useEditor.getState();
    expect(s.project!.clips).toHaveLength(4);
    expect(s.clipboard).not.toBeNull();
    expect(s.clipSel).toHaveLength(2);

    st.setPlayhead(12);
    st.paste();
    s = useEditor.getState();
    expect(s.project!.clips).toHaveLength(6);
    const at12 = s.project!.clips.filter((c) => Math.abs(c.timelineStart - 12) < 1e-6);
    expect(at12.map((c) => c.kind).sort()).toEqual(["audio", "video"]);
    expect(at12[0].linkGroup).toBe(at12[1].linkGroup);
  });

  it("cut pastes once, then clears", () => {
    const p = load();
    const st = useEditor.getState();
    st.setClipSel(collectLaneSpans(p, "video", 2, 4));
    st.cutOrSlice();
    expect(useEditor.getState().clipboard?.consume).toBe(true);
    st.setPlayhead(8);
    st.paste();
    expect(useEditor.getState().clipboard).toBeNull();
  });
});

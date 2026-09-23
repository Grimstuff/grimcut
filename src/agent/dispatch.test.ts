import { describe, expect, it } from "vitest";
import { fromMedia, timelineDuration } from "../core/project";
import type { Clip, MediaInfo, VideoProject } from "../core/types";
import { dispatchAgent } from "./dispatch";
import type { AgentHost } from "./host";
import { clipsToAgent } from "./protocol";

const info: MediaInfo = {
  path: "C:/x.mp4",
  duration: 120,
  hasAudio: true,
  keyframeTimes: [],
};

function memHost(): AgentHost {
  let project: VideoProject | null = fromMedia(info);
  let playhead = 0;
  let collapse = false;
  const undo: Clip[][] = [];
  return {
    snapshot: () => ({
      connected: "headless",
      path: project?.sourcePath ?? null,
      duration: project ? timelineDuration(project) : 0,
      playhead,
      canvas: { width: 1920, height: 1080 },
      clips: project ? clipsToAgent(project.clips) : [],
      collapseBlank: collapse,
      busy: false,
      status: "ok",
      canUndo: undo.length > 0,
      canRedo: false,
    }),
    open: async () => {},
    close: () => {
      project = null;
    },
    setPlayhead: (t) => {
      playhead = t;
    },
    applyClips: (clips) => {
      if (!project) return;
      undo.push(project.clips);
      project = { ...project, clips };
    },
    project: () => project,
    collapseBlank: () => collapse,
    setCollapseBlank: (v) => {
      collapse = v;
    },
    undo: () => {},
    redo: () => {},
    exportVideo: async () => {},
    grabFrame: async () => "C:/frame.jpg",
  };
}

describe("agent dispatch", () => {
  it("deletes the first minute and packs left", async () => {
    const host = memHost();
    const cut = await dispatchAgent(host, "delete_range", { start: 0, end: 60 });
    expect(cut.ok).toBe(true);
    const pack = await dispatchAgent(host, "collapse_blank", {});
    expect(pack.ok).toBe(true);
    const vids = pack.snapshot.clips.filter((c) => c.kind === "video");
    expect(vids[0].start).toBe(0);
    expect(vids[0].sourceStart).toBeGreaterThan(59);
    expect(pack.snapshot.duration).toBeLessThan(61);
  });

  it("sets playhead", async () => {
    const host = memHost();
    const r = await dispatchAgent(host, "playhead", { time: 12.5 });
    expect(r.snapshot.playhead).toBe(12.5);
  });
});

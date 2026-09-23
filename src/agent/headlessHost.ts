import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { collapseBlank } from "../core/edits";
import { fromMedia, timelineDuration } from "../core/project";
import type { Clip, MediaInfo, VideoProject } from "../core/types";
import { exportSimple, grabFrame, probeMedia } from "./ffmpeg";
import type { AgentHost } from "./host";
import { clipsToAgent, type AgentSnapshot } from "./protocol";

type Saved = {
  project: VideoProject | null;
  media: MediaInfo | null;
  playhead: number;
  collapse: boolean;
  status: string;
  undo: Clip[][];
  redo: Clip[][];
};

function sessionPath() {
  return join(homedir(), "AppData", "Local", "Grimcut", "session.json");
}

function loadSaved(): Saved | null {
  const p = sessionPath();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Saved;
  } catch {
    return null;
  }
}

export function createHeadlessHost(): AgentHost {
  const saved = loadSaved();
  let project: VideoProject | null = saved?.project ?? null;
  let media: MediaInfo | null = saved?.media ?? null;
  let playhead = saved?.playhead ?? 0;
  let collapse = saved?.collapse ?? false;
  let status = saved?.status ?? "Headless — no project";
  const undo: Clip[][] = saved?.undo ?? [];
  const redo: Clip[][] = saved?.redo ?? [];

  const persist = () => {
    const p = sessionPath();
    mkdirSync(dirname(p), { recursive: true });
    const dump: Saved = { project, media, playhead, collapse, status, undo, redo };
    writeFileSync(p, JSON.stringify(dump));
  };

  const snap = (): AgentSnapshot => ({
    connected: "headless",
    path: project?.sourcePath ?? null,
    duration: project ? timelineDuration(project) : 0,
    playhead,
    canvas: project ? { width: project.canvasWidth, height: project.canvasHeight } : null,
    clips: project ? clipsToAgent(project.clips) : [],
    collapseBlank: collapse,
    busy: false,
    status,
    canUndo: undo.length > 0,
    canRedo: redo.length > 0,
  });

  return {
    snapshot: snap,
    open: async (path) => {
      media = await probeMedia(path);
      project = fromMedia(media);
      playhead = 0;
      undo.length = 0;
      redo.length = 0;
      status = `Opened ${path}`;
      persist();
    },
    close: () => {
      project = null;
      media = null;
      playhead = 0;
      undo.length = 0;
      redo.length = 0;
      status = "Headless — no project";
      persist();
    },
    setPlayhead: (t) => {
      playhead = Math.max(0, t);
      persist();
    },
    applyClips: (clips, label) => {
      if (!project) return;
      undo.push(project.clips);
      redo.length = 0;
      const next = collapse ? collapseBlank(clips) : clips;
      project = { ...project, clips: next };
      status = label;
      persist();
    },
    project: () => project,
    collapseBlank: () => collapse,
    setCollapseBlank: (v) => {
      collapse = v;
      persist();
    },
    undo: () => {
      if (!project || !undo.length) return;
      redo.push(project.clips);
      project = { ...project, clips: undo.pop()! };
      status = "Undo";
      persist();
    },
    redo: () => {
      if (!project || !redo.length) return;
      undo.push(project.clips);
      project = { ...project, clips: redo.pop()! };
      status = "Redo";
      persist();
    },
    exportVideo: async (opts) => {
      if (!project) throw new Error("No project open.");
      const dest = opts.outputPath;
      if (!dest) throw new Error("outputPath is required in headless export.");
      await exportSimple(project, dest);
      status = `Saved ${dest}`;
      persist();
    },
    grabFrame: async (time) => {
      if (!project) throw new Error("No project open.");
      return grabFrame(project, time);
    },
  };
}

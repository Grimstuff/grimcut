import type { Clip, VideoProject } from "../core/types";
import type { AgentSnapshot } from "./protocol";

export type AgentHost = {
  snapshot: () => AgentSnapshot;
  open: (path: string) => Promise<void>;
  close: () => void;
  setPlayhead: (t: number) => void;
  applyClips: (clips: Clip[], label: string) => void;
  project: () => VideoProject | null;
  collapseBlank: () => boolean;
  setCollapseBlank: (v: boolean) => void;
  undo: () => void;
  redo: () => void;
  exportVideo: (opts: { profile?: string; outputPath?: string }) => Promise<void>;
  grabFrame: (time: number) => Promise<string>;
};

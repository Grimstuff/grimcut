import type { Clip, ClipKind } from "../core/types";

export type AgentOp =
  | "status"
  | "open"
  | "close"
  | "playhead"
  | "slice"
  | "delete_range"
  | "collapse_blank"
  | "undo"
  | "redo"
  | "export"
  | "select"
  | "frame";

export type AgentRequest = {
  id: string;
  op: AgentOp;
  args?: Record<string, unknown>;
};

export type AgentClip = {
  id: string;
  kind: ClipKind;
  layer: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
};

export type AgentSnapshot = {
  connected: "app" | "headless";
  path: string | null;
  duration: number;
  playhead: number;
  canvas: { width: number; height: number } | null;
  clips: AgentClip[];
  collapseBlank: boolean;
  busy: boolean;
  status: string;
  canUndo: boolean;
  canRedo: boolean;
};

export type AgentResult = {
  ok: boolean;
  error?: string;
  snapshot: AgentSnapshot;
  /** JPEG still of the picture at a timeline time (not a GUI screenshot). */
  framePath?: string;
};

export function clipsToAgent(clips: Clip[]): AgentClip[] {
  return clips.map((c) => ({
    id: c.id,
    kind: c.kind,
    layer: c.layer,
    start: c.timelineStart,
    end: c.timelineStart + (c.sourceEnd - c.sourceStart),
    sourceStart: c.sourceStart,
    sourceEnd: c.sourceEnd,
  }));
}

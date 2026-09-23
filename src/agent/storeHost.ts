import { invoke } from "@tauri-apps/api/core";
import { clipSourcePath, mapTimelineToSource, timelineDuration } from "../core/project";
import { useEditor } from "../store/editorStore";
import type { AgentHost } from "./host";
import { clipsToAgent, type AgentSnapshot } from "./protocol";

export function storeHost(): AgentHost {
  return {
    snapshot: (): AgentSnapshot => {
      const s = useEditor.getState();
      const p = s.project;
      return {
        connected: "app",
        path: p?.sourcePath ?? null,
        duration: p ? timelineDuration(p) : 0,
        playhead: s.playhead,
        canvas: p ? { width: p.canvasWidth, height: p.canvasHeight } : null,
        clips: p ? clipsToAgent(p.clips) : [],
        collapseBlank: s.collapseBlank,
        busy: s.busy,
        status: s.status,
        canUndo: s.canUndo,
        canRedo: s.canRedo,
      };
    },
    open: (path) => useEditor.getState().openPath(path),
    close: () => useEditor.getState().closeProject(),
    setPlayhead: (t) => {
      useEditor.getState().setPlayhead(t);
    },
    applyClips: (clips, label) => useEditor.getState().applyEdit(clips, label),
    project: () => useEditor.getState().project,
    collapseBlank: () => useEditor.getState().collapseBlank,
    setCollapseBlank: (v) => useEditor.getState().setCollapseBlank(v),
    undo: () => useEditor.getState().undo(),
    redo: () => useEditor.getState().redo(),
    exportVideo: (opts) =>
      useEditor.getState().exportVideo({ profile: (opts.profile as "quick") ?? "quick", outputPath: opts.outputPath }),
    grabFrame: async (time) => {
      const p = useEditor.getState().project;
      if (!p) throw new Error("No project open.");
      const mapped = mapTimelineToSource(p, time);
      if (!mapped) throw new Error("No video at that time.");
      return invoke<string>("grab_frame", {
        path: clipSourcePath(p, mapped.clip),
        time: mapped.source,
      });
    },
  };
}

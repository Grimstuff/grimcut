import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ClipSegment, MediaInfo, VideoProject } from "../core/types";
import { clipDuration, formatTime } from "../core/types";
import {
  clampTimeline,
  followSourcePlayback,
  fromMedia,
  getSegmentAtTimeline,
  isTimelineGap,
  mapTimelineToSource,
  nextClipAfter,
  rulerDuration,
  snapTimelineStart,
  timelineDuration,
} from "../core/project";
import { UndoStack, tryCut, tryDelete, tryMove, tryTrim } from "../core/edits";
import { canStreamCopyAllClips } from "../core/keyframes";

const history = new UndoStack();

type EditorState = {
  project: VideoProject | null;
  media: MediaInfo | null;
  playhead: number;
  selectedId: string | null;
  status: string;
  busy: boolean;
  previewUrl: string | null;
  showBlack: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  openPath: (path: string) => Promise<void>;
  pickOpen: () => Promise<void>;
  closeProject: () => void;
  setPlayhead: (t: number, seek: boolean) => number | null;
  reportSource: (source: number, playing: boolean) => { seek?: number; gap?: { end: number; source: number; id: string }; stop?: boolean };
  cut: () => void;
  del: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string) => void;
  liveTrimLeft: (id: string, sourceStart: number) => void;
  liveTrimRight: (id: string, sourceEnd: number) => void;
  liveMove: (id: string, timelineStart: number) => void;
  commit: (before: ClipSegment[], label: string) => void;
  snapshot: () => ClipSegment[] | null;
  exportVideo: () => Promise<void>;
};

function syncHist(s: Partial<EditorState>): Partial<EditorState> {
  return {
    ...s,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  };
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  media: null,
  playhead: 0,
  selectedId: null,
  status: "Drop a video or File → Open…",
  busy: false,
  previewUrl: null,
  showBlack: false,
  canUndo: false,
  canRedo: false,
  undoLabel: "Undo",
  redoLabel: "Redo",

  openPath: async (path) => {
    set({ busy: true, status: "Probing…" });
    try {
      const media = await invoke<MediaInfo>("probe", { path });
      history.clear();
      const project = fromMedia(media);
      let previewUrl = convertFileSrc(path);
      const ext = path.toLowerCase();
      const nativeOk = /\.(mp4|m4v|webm|mov)$/i.test(ext);
      if (!nativeOk) {
        try {
          const proxy = await invoke<string>("make_proxy", { path });
          previewUrl = convertFileSrc(proxy);
        } catch {
          /* try native anyway */
        }
      }
      set(
        syncHist({
          project,
          media,
          playhead: 0,
          selectedId: project.segments[0]?.id ?? null,
          previewUrl,
          showBlack: false,
          busy: false,
          status: `${path.split(/[/\\]/).pop()} — ${formatTime(media.duration)}${media.width ? ` · ${media.width}×${media.height}` : ""} · ${media.keyframeTimes.length} KF`,
        }),
      );
    } catch (e) {
      set({ busy: false, status: String(e) });
    }
  },

  pickOpen: async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv"] }],
    });
    if (typeof path === "string") await get().openPath(path);
  },

  closeProject: () => {
    history.clear();
    set(
      syncHist({
        project: null,
        media: null,
        playhead: 0,
        selectedId: null,
        previewUrl: null,
        showBlack: false,
        status: "Drop a video or File → Open…",
      }),
    );
  },

  setPlayhead: (t, _seek) => {
    const p = get().project;
    if (!p) return null;
    const max = rulerDuration(p);
    const playhead = Math.max(0, Math.min(max, t));
    const hit = getSegmentAtTimeline(p, playhead);
    const mapped = mapTimelineToSource(p, playhead);
    set({
      playhead,
      selectedId: hit?.segment.id ?? get().selectedId,
      showBlack: isTimelineGap(p, playhead),
    });
    return mapped?.source ?? null;
  },

  reportSource: (source, playing) => {
    const p = get().project;
    if (!p) return {};
    if (!playing) {
      const hit = p.segments.find((s) => source >= s.sourceStart && source < s.sourceEnd);
      if (hit) {
        const tl = hit.timelineStart + (source - hit.sourceStart);
        if (Math.abs(get().playhead - tl) > 0.008) set({ playhead: tl, selectedId: hit.id, showBlack: false });
      }
      return {};
    }
    const follow = followSourcePlayback(p, source, get().selectedId);
    if (Math.abs(get().playhead - follow.timeline) > 0.008) set({ playhead: follow.timeline });
    if (follow.kind === "continue" && follow.segmentId) {
      set({ selectedId: follow.segmentId, showBlack: false });
    }
    if (follow.kind === "jump" && follow.seekSource != null) {
      if (follow.segmentId) set({ selectedId: follow.segmentId, showBlack: false });
      return { seek: follow.seekSource };
    }
    if (follow.kind === "gap" && follow.gapEnd != null && follow.seekSource != null && follow.segmentId) {
      set({ showBlack: true, selectedId: null });
      return { gap: { end: follow.gapEnd, source: follow.seekSource, id: follow.segmentId } };
    }
    if (follow.kind === "stop") {
      set({ playhead: clampTimeline(p, follow.timeline), showBlack: isTimelineGap(p, follow.timeline) });
      return { stop: true };
    }
    return {};
  },

  cut: () => {
    const p = get().project;
    if (!p) return;
    const r = tryCut(p, get().playhead);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    history.push(p.segments, r.segments, "Cut");
    set(syncHist({ project: { ...p, segments: r.segments }, status: `Cut at ${formatTime(get().playhead)} · ${r.segments.length} clips` }));
  },

  del: () => {
    const p = get().project;
    const id = get().selectedId;
    if (!p || !id) return;
    const r = tryDelete(p, id);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    history.push(p.segments, r.segments, "Delete clip");
    const next = { ...p, segments: r.segments };
    set(
      syncHist({
        project: next,
        selectedId: r.segments[0]?.id ?? null,
        playhead: clampTimeline(next, get().playhead),
        showBlack: isTimelineGap(next, get().playhead),
        status: `Deleted clip · ${r.segments.length} remaining`,
      }),
    );
  },

  undo: () => {
    const p = get().project;
    const segs = history.popUndo();
    if (!p || !segs) return;
    const next = { ...p, segments: segs };
    set(syncHist({ project: next, status: history.undoLabel, playhead: clampTimeline(next, get().playhead) }));
  },

  redo: () => {
    const p = get().project;
    const segs = history.popRedo();
    if (!p || !segs) return;
    const next = { ...p, segments: segs };
    set(syncHist({ project: next, status: history.redoLabel, playhead: clampTimeline(next, get().playhead) }));
  },

  select: (id) => set({ selectedId: id }),

  liveTrimLeft: (id, sourceStart) => {
    const p = get().project;
    if (!p) return;
    const seg = p.segments.find((s) => s.id === id);
    if (!seg) return;
    const fixedEnd = seg.timelineStart + clipDuration(seg);
    let start = Math.max(0, sourceStart);
    if (start > seg.sourceEnd - 0.05) start = seg.sourceEnd - 0.05;
    const dur = seg.sourceEnd - start;
    const r = tryTrim(p, id, { sourceStart: start, timelineStart: Math.max(0, fixedEnd - dur) });
    if (r.ok) set({ project: { ...p, segments: r.segments } });
  },

  liveTrimRight: (id, sourceEnd) => {
    const p = get().project;
    if (!p) return;
    const r = tryTrim(p, id, { sourceEnd });
    if (r.ok) set({ project: { ...p, segments: r.segments } });
  },

  liveMove: (id, timelineStart) => {
    const p = get().project;
    if (!p) return;
    const seg = p.segments.find((s) => s.id === id);
    if (!seg) return;
    const snapped = snapTimelineStart(p, id, timelineStart, clipDuration(seg));
    const r = tryMove(p, id, snapped);
    if (r.ok) set({ project: { ...p, segments: r.segments } });
  },

  commit: (before, label) => {
    const p = get().project;
    if (!p) return;
    history.push(before, p.segments, label);
    set(syncHist({ status: `${label} · timeline ${formatTime(timelineDuration(p))}` }));
  },

  snapshot: () => get().project?.segments.map((s) => ({ ...s })) ?? null,

  exportVideo: async () => {
    const { project, media, busy } = get();
    if (!project || !media || busy) return;
    const suggested = await invoke<string>("suggest_save", { path: project.sourcePath });
    const dest = await save({
      defaultPath: suggested,
      filters: [{ name: "Video", extensions: [suggested.split(".").pop() ?? "mp4"] }],
    });
    if (!dest) return;
    const clips = [...project.segments]
      .filter((s) => clipDuration(s) > 0.02)
      .sort((a, b) => a.timelineStart - b.timelineStart)
      .map((s) => ({ sourceStart: s.sourceStart, sourceEnd: s.sourceEnd }));
    const useStreamCopy = canStreamCopyAllClips(project.segments, media.keyframeTimes, media.frameRate);
    set({ busy: true, status: useStreamCopy ? "Exporting (stream copy)…" : "Exporting (re-encode)…" });
    try {
      const result = await invoke<{ message: string; outputPath: string; mode: string }>("export_video", {
        plan: {
          sourcePath: project.sourcePath,
          outputPath: dest,
          clips,
          hasAudio: media.hasAudio,
          videoCodec: media.videoCodec,
          useStreamCopy,
        },
      });
      set({ busy: false, status: `Saved: ${result.outputPath} · ${result.message}` });
    } catch (e) {
      set({ busy: false, status: `Export failed: ${e}` });
    }
  },
}));

export function gapFromPlayhead(): { end: number; source: number; id: string } | null {
  const p = useEditor.getState().project;
  const t = useEditor.getState().playhead;
  if (!p || !isTimelineGap(p, t)) return null;
  const next = nextClipAfter(p, t);
  if (!next) return null;
  return { end: next.timelineStart, source: next.sourceStart, id: next.id };
}

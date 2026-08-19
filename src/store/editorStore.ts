import { create } from "zustand";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Clip, ClipKind, ClipboardChunk, MediaInfo, TimeRange, VideoProject } from "../core/types";
import { formatTime } from "../core/types";
import {
  clipAt,
  flattenKind,
  followSourcePlayback,
  fromMedia,
  isTimelineGap,
  mapTimelineToSource,
  nextVideoAfter,
  rulerDuration,
  snapStart,
  timelineDuration,
} from "../core/project";
import {
  UndoStack,
  chunkFromRange,
  tryDelete,
  tryMove,
  tryPaste,
  trySlice,
  tryToggleLink,
  tryTrim,
} from "../core/edits";
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
  peaks: number[];
  zoom: number;
  viewStart: number;
  range: (TimeRange & { kind: ClipKind }) | null;
  clipboard: ClipboardChunk | null;
  openPath: (path: string) => Promise<void>;
  pickOpen: () => Promise<void>;
  closeProject: () => void;
  setPlayhead: (t: number) => number | null;
  reportSource: (source: number, playing: boolean) => {
    seek?: number;
    gap?: { end: number; source: number; id: string };
    stop?: boolean;
  };
  slice: (at?: number, clipId?: string) => void;
  del: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  liveTrim: (id: string, edge: "left" | "right", sourceEdge: number) => void;
  liveMove: (id: string, timelineStart: number) => void;
  commit: (before: Clip[], label: string) => void;
  snapshot: () => Clip[] | null;
  toggleLink: (id: string) => void;
  setRange: (r: (TimeRange & { kind: ClipKind }) | null) => void;
  copyRange: () => void;
  paste: (kind?: ClipKind) => void;
  setZoom: (z: number, anchorTime?: number) => void;
  setViewStart: (t: number) => void;
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

function applyClips(get: () => EditorState, set: (s: Partial<EditorState>) => void, clips: Clip[], label: string) {
  const p = get().project;
  if (!p) return;
  history.push(p.clips, clips, label);
  set(syncHist({ project: { ...p, clips }, status: label }));
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
  peaks: [],
  zoom: 80,
  viewStart: 0,
  range: null,
  clipboard: null,

  openPath: async (path) => {
    set({ busy: true, status: "Probing…" });
    try {
      const media = await invoke<MediaInfo>("probe", { path });
      history.clear();
      const project = fromMedia(media);
      let previewUrl = convertFileSrc(path);
      if (!/\.(mp4|m4v|webm|mov)$/i.test(path)) {
        try {
          previewUrl = convertFileSrc(await invoke<string>("make_proxy", { path }));
        } catch {
          /* native */
        }
      }
      let peaks: number[] = [];
      if (media.hasAudio) {
        try {
          peaks = await invoke<number[]>("waveform", { path });
        } catch {
          peaks = [];
        }
      }
      set(
        syncHist({
          project,
          media,
          playhead: 0,
          selectedId: project.clips[0]?.id ?? null,
          previewUrl,
          showBlack: false,
          busy: false,
          peaks,
          zoom: Math.max(40, Math.min(140, 900 / Math.max(media.duration, 1))),
          viewStart: 0,
          range: null,
          clipboard: null,
          status: `${path.split(/[/\\]/).pop()} — ${formatTime(media.duration)}`,
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
        peaks: [],
        range: null,
        status: "Drop a video or File → Open…",
      }),
    );
  },

  setPlayhead: (t) => {
    const p = get().project;
    if (!p) return null;
    const max = rulerDuration(p);
    const playhead = Math.max(0, Math.min(max, t));
    const hit = clipAt(p, playhead, "video");
    const mapped = mapTimelineToSource(p, playhead);
    set({
      playhead,
      selectedId: hit?.id ?? get().selectedId,
      showBlack: isTimelineGap(p, playhead),
    });
    return mapped?.source ?? null;
  },

  reportSource: (source, playing) => {
    const p = get().project;
    if (!p) return {};
    if (!playing) {
      const hit = p.clips.find((c) => c.kind === "video" && source >= c.sourceStart && source < c.sourceEnd);
      if (hit) {
        const tl = hit.timelineStart + (source - hit.sourceStart);
        if (Math.abs(get().playhead - tl) > 0.008) set({ playhead: tl, selectedId: hit.id, showBlack: false });
      }
      return {};
    }
    const follow = followSourcePlayback(p, source, get().selectedId);
    if (Math.abs(get().playhead - follow.timeline) > 0.008) set({ playhead: follow.timeline });
    if (follow.kind === "continue" && follow.segmentId) set({ selectedId: follow.segmentId, showBlack: false });
    if (follow.kind === "jump" && follow.seekSource != null) {
      if (follow.segmentId) set({ selectedId: follow.segmentId, showBlack: false });
      return { seek: follow.seekSource };
    }
    if (follow.kind === "gap" && follow.gapEnd != null && follow.seekSource != null && follow.segmentId) {
      set({ showBlack: true, selectedId: null });
      return { gap: { end: follow.gapEnd, source: follow.seekSource, id: follow.segmentId } };
    }
    if (follow.kind === "stop") {
      set({ playhead: follow.timeline, showBlack: isTimelineGap(p, follow.timeline) });
      return { stop: true };
    }
    return {};
  },

  slice: (at, clipId) => {
    const p = get().project;
    if (!p) return;
    const r = trySlice(p, at ?? get().playhead, clipId);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, "Slice");
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
    applyClips(get, set, r.clips, "Delete");
  },

  undo: () => {
    const p = get().project;
    const clips = history.popUndo();
    if (!p || !clips) return;
    set(syncHist({ project: { ...p, clips } }));
  },

  redo: () => {
    const p = get().project;
    const clips = history.popRedo();
    if (!p || !clips) return;
    set(syncHist({ project: { ...p, clips } }));
  },

  select: (id) => set({ selectedId: id }),

  liveTrim: (id, edge, sourceEdge) => {
    const p = get().project;
    if (!p) return;
    const r = tryTrim(p, id, edge, sourceEdge);
    if (r.ok) set({ project: { ...p, clips: r.clips } });
  },

  liveMove: (id, timelineStart) => {
    const p = get().project;
    if (!p) return;
    const clip = p.clips.find((c) => c.id === id);
    if (!clip) return;
    const snapped = snapStart(p, { ...clip, timelineStart }, timelineStart);
    const r = tryMove(p, id, snapped);
    if (r.ok) set({ project: { ...p, clips: r.clips } });
  },

  commit: (before, label) => {
    const p = get().project;
    if (!p) return;
    history.push(before, p.clips, label);
    set(syncHist({ status: `${label} · ${formatTime(timelineDuration(p))}` }));
  },

  snapshot: () => get().project?.clips.map((s) => ({ ...s })) ?? null,

  toggleLink: (id) => {
    const p = get().project;
    if (!p) return;
    const r = tryToggleLink(p, id);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, r.clips.some((c) => c.id === id && c.linkGroup) ? "Link A/V" : "Unlink A/V");
  },

  setRange: (range) => set({ range }),

  copyRange: () => {
    const p = get().project;
    const range = get().range;
    if (!p || !range) {
      const id = get().selectedId;
      const c = p?.clips.find((x) => x.id === id);
      if (c) {
        set({
          clipboard: { kind: c.kind, sourceStart: c.sourceStart, sourceEnd: c.sourceEnd },
          status: "Copied clip",
        });
      }
      return;
    }
    const chunk = chunkFromRange(p, range.kind, range.start, range.end);
    if (!chunk) {
      set({ status: "Nothing to copy in that range." });
      return;
    }
    set({ clipboard: chunk, status: `Copied ${chunk.kind} ${formatTime(chunk.sourceEnd - chunk.sourceStart)}` });
  },

  paste: (kind) => {
    const p = get().project;
    const clip = get().clipboard;
    if (!p || !clip) {
      set({ status: "Clipboard empty." });
      return;
    }
    const chunk = kind ? { ...clip, kind } : clip;
    const r = tryPaste(p, chunk, get().playhead);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, "Paste");
  },

  setZoom: (z, anchorTime) => {
    const p = get().project;
    const zoom = Math.max(12, Math.min(400, z));
    if (!p) {
      set({ zoom });
      return;
    }
    const anchor = anchorTime ?? get().playhead;
    const old = get().zoom;
    const viewStart = get().viewStart;
    const screen = (anchor - viewStart) * old;
    const nextStart = Math.max(0, anchor - screen / zoom);
    set({ zoom, viewStart: nextStart });
  },

  setViewStart: (t) => set({ viewStart: Math.max(0, t) }),

  exportVideo: async () => {
    const { project, media, busy } = get();
    if (!project || !media || busy) return;
    const suggested = await invoke<string>("suggest_save", { path: project.sourcePath });
    const dest = await save({
      defaultPath: suggested,
      filters: [{ name: "Video", extensions: [suggested.split(".").pop() ?? "mp4"] }],
    });
    if (!dest) return;
    const clips = flattenKind(project, "video");
    const audioClips = flattenKind(project, "audio");
    const videoClips = project.clips.filter((c) => c.kind === "video");
    const useStreamCopy = canStreamCopyAllClips(videoClips, media.keyframeTimes, media.frameRate) && audioClips.length === clips.length;
    set({ busy: true, status: useStreamCopy ? "Exporting (stream copy)…" : "Exporting (re-encode)…" });
    try {
      const result = await invoke<{ message: string; outputPath: string }>("export_video", {
        plan: {
          sourcePath: project.sourcePath,
          outputPath: dest,
          clips,
          audioClips,
          hasAudio: media.hasAudio && audioClips.length > 0,
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
  const next = nextVideoAfter(p, t);
  if (!next) return null;
  return { end: next.timelineStart, source: next.sourceStart, id: next.id };
}

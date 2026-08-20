import { create } from "zustand";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Clip, ClipKind, ClipboardChunk, MediaInfo, TimeRange, VideoProject } from "../core/types";
import { formatTime } from "../core/types";
import {
  clipAt,
  flattenKind,
  fromMedia,
  isTimelineGap,
  mapTimelineToSource,
  rulerDuration,
  snapStart,
  timelineDuration,
} from "../core/project";
import {
  UndoStack,
  chunkFromRange,
  tryDelete,
  tryLiftRange,
  tryMove,
  tryPaste,
  trySlice,
  tryToggleLink,
  tryTrim,
} from "../core/edits";
import { canStreamCopyAllClips, snapToKeyframe } from "../core/keyframes";
import { fitWindowToVideo } from "../lib/fitWindow";

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
  playing: boolean;
  menuOpen: boolean;
  progress: { label: string; pct: number } | null;
  openPath: (path: string) => Promise<void>;
  pickOpen: () => Promise<void>;
  closeProject: () => void;
  setPlayhead: (t: number) => number | null;
  slice: (at?: number, clipId?: string) => void;
  del: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  liveTrim: (id: string, edge: "left" | "right", sourceEdge: number, snapSec?: number) => void;
  liveMove: (id: string, timelineStart: number, snapSec?: number) => void;
  commit: (before: Clip[], label: string) => void;
  snapshot: () => Clip[] | null;
  toggleLink: (id: string) => void;
  setRange: (r: (TimeRange & { kind: ClipKind }) | null) => void;
  copyRange: () => void;
  liftRange: () => void;
  paste: (kind?: ClipKind) => void;
  setZoom: (z: number, anchorTime?: number) => void;
  setViewStart: (t: number) => void;
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;
  setMenuOpen: (v: boolean) => void;
  setProgress: (p: { label: string; pct: number } | null) => void;
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
  playing: false,
  menuOpen: false,
  progress: null,

  setPlaying: (v) => set({ playing: v }),
  togglePlay: () => {
    const st = get();
    if (st.menuOpen) {
      set({ menuOpen: false });
      return;
    }
    if (!st.project) return;
    if (st.playing) {
      set({ playing: false });
      return;
    }
    set({ playing: true });
  },
  setMenuOpen: (v) => set({ menuOpen: v }),
  setProgress: (p) => set({ progress: p, busy: p != null }),

  openPath: async (path) => {
    set({ busy: true, progress: { label: "Reading media…", pct: 8 }, status: "Opening…" });
    try {
      const media = await invoke<MediaInfo>("probe", { path });
      history.clear();
      const project = fromMedia(media);
      set({ progress: { label: "Preparing preview…", pct: 40 } });
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
        set({ progress: { label: "Building waveform…", pct: 65 } });
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
          progress: null,
          peaks,
          zoom: 1,
          viewStart: 0,
          range: null,
          clipboard: null,
          playing: false,
          status: `${path.split(/[/\\]/).pop()} — ${formatTime(media.duration)}`,
        }),
      );
      if (media.width && media.height) {
        requestAnimationFrame(() => {
          void fitWindowToVideo(media.width!, media.height!);
        });
      }
    } catch (e) {
      set({ busy: false, progress: null, status: String(e) });
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
        playing: false,
        progress: null,
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

  slice: (at, clipId) => {
    const p = get().project;
    if (!p) return;
    let t = at ?? get().playhead;
    const kfs = get().media?.keyframeTimes ?? [];
    const under = p.clips.find((c) => t > c.timelineStart && t < c.timelineStart + (c.sourceEnd - c.sourceStart) && c.kind === "video");
    if (under && kfs.length) {
      const src = under.sourceStart + (t - under.timelineStart);
      const snapped = snapToKeyframe(src, kfs, 0.15);
      t = under.timelineStart + (snapped - under.sourceStart);
    }
    const r = trySlice(p, t, clipId);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, "Slice");
  },

  del: () => {
    if (get().range) {
      get().liftRange();
      return;
    }
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

  liveTrim: (id, edge, sourceEdge, snapSec = 0.12) => {
    const p = get().project;
    if (!p) return;
    const kfs = get().media?.keyframeTimes ?? [];
    const snapped = snapToKeyframe(sourceEdge, kfs, snapSec);
    const r = tryTrim(p, id, edge, snapped);
    if (r.ok) set({ project: { ...p, clips: r.clips } });
  },

  liveMove: (id, timelineStart, snapSec = 0.12) => {
    const p = get().project;
    if (!p) return;
    const clip = p.clips.find((c) => c.id === id);
    if (!clip) return;
    const kfs = get().media?.keyframeTimes ?? [];
    let best = snapStart(p, clip, timelineStart, snapSec);
    let bestD = Math.abs(best - timelineStart);
    const consider = (cand: number) => {
      if (cand < 0) return;
      const d = Math.abs(cand - timelineStart);
      if (d <= snapSec && d < bestD) {
        bestD = d;
        best = cand;
      }
    };
    for (const kf of kfs) {
      if (kf < clip.sourceStart - 0.05 || kf > clip.sourceEnd + 0.05) continue;
      const offset = kf - clip.sourceStart;
      for (const other of p.clips) {
        if (other.id === clip.id) continue;
        consider(other.timelineStart - offset);
        consider(other.timelineStart + (other.sourceEnd - other.sourceStart) - offset);
      }
      consider(-offset);
    }
    const r = tryMove(p, id, best);
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

  liftRange: () => {
    const p = get().project;
    const range = get().range;
    if (!p || !range) {
      set({ status: "Drag a range on a bar first." });
      return;
    }
    const chunk = chunkFromRange(p, range.kind, range.start, range.end);
    const r = tryLiftRange(p, range.kind, range.start, range.end);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, "Cut range");
    const dur = range.end - range.start;
    set({
      clipboard: chunk,
      range: null,
      status: chunk
        ? `Cut ${formatTime(dur)} hole — Ctrl+V pastes at playhead`
        : `Cut ${formatTime(dur)} hole`,
    });
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
    const added = r.clips.find((c) => !p.clips.some((old) => old.id === c.id));
    set({
      selectedId: added?.id ?? get().selectedId,
      status:
        added?.layer === "over"
          ? "Pasted as overlay (on top where it overlaps) — Ctrl+Z to undo"
          : "Paste",
    });
  },

  setZoom: (z, anchorTime) => {
    // zoom is a scale over "fit entire timeline in the track". 1 = full width.
    const zoom = Math.max(1, Math.min(256, z));
    const p = get().project;
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
    const hasGap = clips.some((c) => c.gap) || audioClips.some((c) => c.gap);
    const mediaOnly = (segs: typeof clips) =>
      segs.filter((s) => !s.gap).map((s) => ({ sourceStart: s.sourceStart, sourceEnd: s.sourceEnd }));
    const useStreamCopy =
      !hasGap &&
      canStreamCopyAllClips(videoClips, media.keyframeTimes, media.frameRate) &&
      mediaOnly(audioClips).length === mediaOnly(clips).length;
    set({
      busy: true,
      progress: { label: useStreamCopy ? "Saving (stream copy)…" : "Saving…", pct: 12 },
      status: useStreamCopy ? "Exporting (stream copy)…" : "Exporting (re-encode)…",
    });
    try {
      const result = await invoke<{ message: string; outputPath: string }>("export_video", {
        plan: {
          sourcePath: project.sourcePath,
          outputPath: dest,
          clips,
          audioClips,
          hasAudio: media.hasAudio,
          videoCodec: media.videoCodec,
          useStreamCopy,
          width: media.width,
          height: media.height,
          frameRate: media.frameRate,
        },
      });
      set({ busy: false, progress: null, status: `Saved: ${result.outputPath} · ${result.message}` });
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/i, "");
      const short = text.split("\n").filter(Boolean).slice(-1)[0] ?? text;
      set({ busy: false, progress: null, status: `Export failed: ${short}` });
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* ignore */
      }
      window.alert(`Export failed (copied to clipboard if allowed):\n\n${text}`);
    }
  },
}));

import { create } from "zustand";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { AnimChannels, AnimKey, Clip, ClipEffect, ClipEffectKind, ClipKind, ClipboardChunk, ClipSpan, MediaInfo, SubCue, SubStyle, TimeRange, VideoProject } from "../core/types";
import { DEFAULT_SUB_STYLE, textSubtitleTracks } from "../core/types";
import { addGainRegion, clipBlur, clipDuration, clipEnd, formatTime, newId } from "../core/types";
import {
  clipAt,
  flattenCanvas,
  flattenKind,
  fromMedia,
  isTimelineGap,
  mapTimelineToSource,
  rulerDuration,
  snapEdge,
  snapStart,
  timelineDuration,
} from "../core/project";
import { AR_PRESETS, RES_BY_AR, evenPx, hugTextClip, maskAnimWrite, motionTarget, poseAt, stepKey, writeTransform, type ClipTransform } from "../core/canvas";
import {
  UndoStack,
  chunkFromRange,
  tryDelete,
  mergeSpans,
  tryAddAudioFromMedia,
  tryAddOverlayFromMedia,
  collapseBlank,
  tryAddText,
  tryDeleteSpans,
  tryLiftRange,
  tryMove,
  tryMoveIds,
  tryPaste,
  tryLinkPair,
  trySlice,
  tryToggleLink,
  tryTrim,
} from "../core/edits";
import { canStreamCopyAllClips, snapToKeyframe } from "../core/keyframes";
import { fitWindowToVideo } from "../lib/fitWindow";
import { soundUnload } from "../lib/previewSound";

const history = new UndoStack();
const VIDEO_RE = /\.(mp4|mkv|mov|avi|webm|m4v|wmv)$/i;
const AUDIO_RE = /\.(mp3|wav|flac|aac|m4a|ogg|opus|wma|aiff|aif|oga)$/i;

function isMediaPath(path: string) {
  return VIDEO_RE.test(path) || AUDIO_RE.test(path);
}

function mediaHasVideo(m: Pick<MediaInfo, "width" | "height" | "videoCodec">) {
  return (m.width ?? 0) > 8 && (m.height ?? 0) > 8;
}

export type DropGhost = {
  path: string;
  name: string;
  duration: number;
  start: number;
  hasAudio: boolean;
  audioOnly: boolean;
  probing: boolean;
};

export type ExportOpts = {
  profile?: "quick" | "discord" | "youtube" | "manual";
  encoder?: string;
  crf?: number;
  preset?: string;
  audioBitrate?: string;
  width?: number;
  height?: number;
  outputPath?: string;
};

function scaleToMaxH(w: number, h: number, maxH: number) {
  if (h <= maxH) return { w: evenPx(w), h: evenPx(h) };
  return { w: evenPx(Math.round((w * maxH) / h)), h: evenPx(maxH) };
}

const thumbBusy = new Set<string>();
const keyBusy = new Set<string>();

// Thumbnails arrive in back-to-back batches; hold each job's status briefly after it
// ends so the next batch picks it up instead of the indicator blinking off and on.
const JOB_LINGER_MS = 700;
const jobLinger = new Map<string, ReturnType<typeof setTimeout>>();

function startJob(get: () => EditorState, set: (s: Partial<EditorState>) => void, id: string, label: string) {
  const pending = jobLinger.get(id);
  if (pending) {
    clearTimeout(pending);
    jobLinger.delete(id);
  }
  if (get().bgJobs[id] === label) return;
  set({ bgJobs: { ...get().bgJobs, [id]: label } });
}

function endJob(get: () => EditorState, set: (s: Partial<EditorState>) => void, id: string) {
  const pending = jobLinger.get(id);
  if (pending) clearTimeout(pending);
  jobLinger.set(
    id,
    setTimeout(() => {
      jobLinger.delete(id);
      const next = { ...get().bgJobs };
      delete next[id];
      set({ bgJobs: next });
    }, JOB_LINGER_MS),
  );
}

function fillKeyframes(get: () => EditorState, set: (s: Partial<EditorState>) => void, path: string) {
  if (!path || keyBusy.has(path)) return;
  keyBusy.add(path);
  startJob(get, set, `kf:${path}`, "keyframes");
  void invoke<number[]>("probe_keyframes", { path })
    .then((times) => {
      const prev = get().mediaByPath[path];
      if (!prev) return;
      const next = { ...prev, keyframeTimes: times };
      set({
        mediaByPath: { ...get().mediaByPath, [path]: next },
        media: get().media?.path === path ? next : get().media,
      });
    })
    .catch(() => {})
    .finally(() => {
      keyBusy.delete(path);
      endJob(get, set, `kf:${path}`);
    });
}

function fileName(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

const PREVIEW_NATIVE = /\.(mp4|m4v|webm|mov)$/i;

async function previewUrlsFor(path: string, videoCodec?: string | null) {
  if (PREVIEW_NATIVE.test(path)) {
    const u = convertFileSrc(path);
    return { video: u, audio: u };
  }
  try {
    const proxy = await invoke<{ video: string; audio: string | null }>("make_proxy", {
      path,
      videoCodec: videoCodec ?? null,
    });
    return {
      video: convertFileSrc(proxy.video),
      audio: proxy.audio ? convertFileSrc(proxy.audio) : convertFileSrc(path),
    };
  } catch {
    const u = convertFileSrc(path);
    return { video: u, audio: u };
  }
}

type EditorState = {
  project: VideoProject | null;
  media: MediaInfo | null;
  playhead: number;
  selectedId: string | null;
  status: string;
  bgJobs: Record<string, string>;
  busy: boolean;
  previewUrl: string | null;
  overlayUrl: string | null;
  overlayPeaks: number[];
  overlayMedia: MediaInfo | null;
  peaksByPath: Record<string, number[]>;
  thumbsByPath: Record<string, Record<string, string>>;
  ensureThumbs: (path: string, times: number[]) => void;
  mediaByPath: Record<string, MediaInfo>;
  previewByPath: Record<string, string>;
  audioPreviewByPath: Record<string, string>;
  dropGhost: DropGhost | null;
  previewOver: boolean;
  showBlack: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  peaks: number[];
  zoom: number;
  viewStart: number;
  range: (TimeRange & { kind: ClipKind }) | null;
  clipSel: ClipSpan[];
  setClipSel: (spans: ClipSpan[]) => void;
  selLane: ClipKind | null;
  setSelLane: (k: ClipKind | null) => void;
  gainDraft: number;
  setGainDraft: (db: number) => void;
  commitGainDraft: () => void;
  cancelGainDraft: () => void;
  clipboard: ClipboardChunk | null;
  playing: boolean;
  menuOpen: boolean;
  progress: { label: string; pct: number } | null;
  collapseBlank: boolean;
  setCollapseBlank: (v: boolean) => void;
  cancelWork: () => void;
  previewVolume: number;
  openPath: (path: string) => Promise<void>;
  dropFile: (path: string, at?: number) => Promise<void>;
  addOverlay: (path: string, at?: number) => Promise<void>;
  addAudio: (path: string, at?: number) => Promise<void>;
  hoverDrop: (path: string, start: number) => void;
  clearDropGhost: () => void;
  pickOpen: () => Promise<void>;
  closeProject: () => void;
  setPlayhead: (t: number, opts?: { keepSelection?: boolean }) => number | null;
  scrubPreview: number | null;
  setScrubPreview: (t: number | null) => void;
  slice: (at?: number, clipId?: string) => void;
  del: () => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  liveTrim: (id: string, edge: "left" | "right", sourceEdge: number, snapSec?: number, from?: Clip[]) => void;
  liveMove: (id: string, timelineStart: number, snapSec?: number, from?: Clip[]) => void;
  liveMoveSel: (id: string, origStart: number, proposedStart: number, snapSec: number, from: Clip[], seedIds: string[]) => void;
  commit: (before: Clip[], label: string) => void;
  applyEdit: (clips: Clip[], label: string) => void;
  snapshot: () => Clip[] | null;
  toggleLink: (id: string) => void;
  linkPair: (aId: string, bId: string) => void;
  setRange: (r: (TimeRange & { kind: ClipKind }) | null) => void;
  copyRange: () => void;
  liftRange: () => void;
  cutOrSlice: () => void;
  paste: (kind?: ClipKind) => void;
  setZoom: (z: number, anchorTime?: number) => void;
  setViewStart: (t: number) => void;
  setPlaying: (v: boolean) => void;
  togglePlay: () => void;
  setMenuOpen: (v: boolean) => void;
  setProgress: (p: { label: string; pct: number } | null) => void;
  setCanvas: (w: number, h: number) => void;
  setCanvasPreset: (id: string) => void;
  setPreviewVolume: (v: number) => void;
  liveTransform: (id: string, xf: ClipTransform, write?: { pan?: boolean; rotate?: boolean; scale?: boolean }) => void;
  selectedAnimId: string | null;
  addAnimKey: (id?: string) => void;
  moveAnimKey: (clipId: string, keyId: string, t: number) => void;
  removeAnimKey: (clipId: string, keyId: string) => void;
  setAnimChannels: (clipId: string, keyId: string, patch: AnimChannels) => void;
  selectAnimKey: (clipId: string | null, keyId: string | null) => void;
  /** Jump the playhead to the previous / next motion key on the keyed clip and select it. */
  stepAnimKey: (dir: 1 | -1) => void;
  addTextClip: () => void;
  setTextProps: (id: string, patch: Partial<Clip>, opts?: { hug?: boolean }) => void;
  hugText: (id: string) => void;
  setEditingText: (id: string | null) => void;
  editingTextId: string | null;
  colorPickId: string | null;
  setColorPick: (id: string | null) => void;
  selectedEffectId: string | null;
  selectEffect: (clipId: string, effectId: string) => void;
  addEffect: (kind: ClipEffectKind) => void;
  setEffectAmount: (effectId: string, amount: number) => void;
  saveProject: () => void;
  exportVideo: (opts?: ExportOpts) => Promise<void>;
  burnSubs: boolean;
  burnSubIndex: number;
  subCues: SubCue[];
  subStyle: SubStyle;
  setBurnSubs: (on: boolean) => void;
  setBurnSubIndex: (index: number) => void;
  setSubStyle: (patch: Partial<SubStyle>) => void;
  exportCodecs: { id: string; label: string }[];
  exportCodecsReady: boolean;
  primeExportCodecs: () => void;
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

/** "overlay (layer 2)" / "main track" for status lines. */
function layerName(c: Clip) {
  return c.layer === "over" ? "overlay (layer 2)" : "main track";
}

function nearestAnim(keys: AnimKey[] | undefined, t: number, within: number): AnimKey | undefined {
  let best: AnimKey | undefined;
  let bestD = within;
  for (const k of keys ?? []) {
    const d = Math.abs(k.t - t);
    if (d < bestD) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

function animFromPose(id: string, t: number, xf: ClipTransform): AnimKey {
  return {
    id,
    t,
    x: xf.x,
    y: xf.y,
    scale: xf.scale,
    scaleX: xf.scaleX ?? xf.scale,
    scaleY: xf.scaleY ?? xf.scale,
    rotation: xf.rotation,
  };
}

function applyClips(get: () => EditorState, set: (s: Partial<EditorState>) => void, clips: Clip[], label: string) {
  const p = get().project;
  if (!p) return;
  const next = get().collapseBlank ? collapseBlank(clips) : clips;
  history.push(p.clips, next, label);
  set(syncHist({ project: { ...p, clips: next }, status: label }));
}

export const useEditor = create<EditorState>((set, get) => ({
  project: null,
  media: null,
  playhead: 0,
  selectedId: null,
  status: "Drop a video or File → Open…",
  busy: false,
  previewUrl: null,
  overlayUrl: null,
  overlayPeaks: [],
  overlayMedia: null,
  peaksByPath: {},
  mediaByPath: {},
  previewByPath: {},
  audioPreviewByPath: {},
  dropGhost: null,
  scrubPreview: null,
  setScrubPreview: (t) => set({ scrubPreview: t }),
  previewOver: false,
  showBlack: false,
  canUndo: false,
  canRedo: false,
  undoLabel: "Undo",
  redoLabel: "Redo",
  peaks: [],
  zoom: 80,
  viewStart: 0,
  range: null,
  clipSel: [],
  selLane: null,
  setSelLane: (k) => set({ selLane: k }),
  gainDraft: 0,
  setGainDraft: (db) => {
    set({ gainDraft: Math.max(-24, Math.min(18, db)) });
    void import("../lib/playbackClock").then(async (m) => {
      await m.ensureAudioGraph();
      m.applyPreviewVolume(get().previewVolume);
    });
  },
  commitGainDraft: () => {
    const p = get().project;
    const draft = get().gainDraft;
    const close = { gainDraft: 0, clipSel: [] as ClipSpan[], selLane: null as ClipKind | null, range: null };
    if (!p || Math.abs(draft) < 0.05) {
      set(close);
      return;
    }
    const spans = get().clipSel.filter((s) => p.clips.find((c) => c.id === s.clipId)?.kind === "audio");
    if (!spans.length) {
      set(close);
      return;
    }
    const clips = p.clips.map((c) => {
      const hit = spans.filter((s) => s.clipId === c.id);
      if (!hit.length) return c;
      let next = c.gainSpans;
      for (const s of hit) {
        const a = c.sourceStart + (s.start - c.timelineStart);
        const b = c.sourceStart + (s.end - c.timelineStart);
        next = addGainRegion(next, a, b, draft);
      }
      return { ...c, gainSpans: next };
    });
    applyClips(get, set, clips, "Audio gain");
    set(close);
    void import("../lib/playbackClock").then((m) => m.applyPreviewVolume(get().previewVolume));
  },
  cancelGainDraft: () => {
    set({ gainDraft: 0, clipSel: [], selLane: null, range: null });
    void import("../lib/playbackClock").then((m) => m.applyPreviewVolume(get().previewVolume));
  },
  clipboard: null,
  playing: false,
  menuOpen: false,
  progress: null,
  previewVolume: 1,
  editingTextId: null,
  colorPickId: null,
  setColorPick: (id) => set({ colorPickId: id }),
  selectedEffectId: null,

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
  collapseBlank: typeof localStorage !== "undefined" && localStorage.getItem("grimcut.collapseBlank") === "1",
  setCollapseBlank: (v) => {
    try {
      localStorage.setItem("grimcut.collapseBlank", v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ collapseBlank: v });
  },
  cancelWork: () => {
    void invoke("cancel_export").catch(() => {});
    set({ busy: false, progress: null, status: "Cancelled." });
  },
  thumbsByPath: {},
  bgJobs: {},
  ensureThumbs: (path, times) => {
    if (!path || !times.length) return;
    const have = get().thumbsByPath[path] ?? {};
    const uniq = [...new Set(times.map((t) => Math.round(t * 20) / 20))]
      .filter((t) => t >= 0 && !have[t.toFixed(2)])
      .slice(0, 24);
    if (!uniq.length || thumbBusy.has(path)) return;
    thumbBusy.add(path);
    startJob(get, set, `thumbs:${path}`, "thumbnails");
    void invoke<{ time: number; path: string }[]>("filmstrip_thumbs", { path, times: uniq })
      .then((rows) => {
        const next = { ...(get().thumbsByPath[path] ?? {}) };
        for (const r of rows) next[(Math.round(r.time * 20) / 20).toFixed(2)] = r.path;
        set({ thumbsByPath: { ...get().thumbsByPath, [path]: next } });
      })
      .catch(() => {})
      .finally(() => {
        thumbBusy.delete(path);
        endJob(get, set, `thumbs:${path}`);
      });
  },

  openPath: async (path) => {
    set({ busy: true, progress: { label: "Reading media…", pct: 8 }, status: "Opening…" });
    try {
      const media = await invoke<MediaInfo>("probe", { path });
      history.clear();
      const project = fromMedia(media);
      set({ progress: { label: PREVIEW_NATIVE.test(path) ? "Preparing preview…" : "Remuxing preview (copy, not re-encode)…", pct: 40 } });
      const urls = await previewUrlsFor(path, media.videoCodec);
      const previewUrl = urls.video;
      set(
        syncHist({
          project,
          media,
          playhead: 0,
          selectedId: project.clips[0]?.id ?? null,
          previewUrl,
          overlayUrl: null,
          overlayPeaks: [],
          overlayMedia: null,
          peaksByPath: {},
          mediaByPath: { [path]: media },
          previewByPath: { [path]: urls.video },
          audioPreviewByPath: { [path]: urls.audio },
          dropGhost: null,
          previewOver: false,
          showBlack: false,
          busy: false,
          progress: null,
          peaks: [],
          thumbsByPath: { ...get().thumbsByPath },
          zoom: 1,
          viewStart: 0,
          range: null,
          clipboard: null,
          playing: false,
          burnSubs: false,
          burnSubIndex: textSubtitleTracks(media)[0]?.index ?? -1,
          subCues: [],
          status: (() => {
            const n = textSubtitleTracks(media).length;
            const name = path.split(/[/\\]/).pop();
            const t = formatTime(media.duration);
            return n ? `${name} — ${t} · ${n} subtitle${n === 1 ? "" : "s"} (CC to burn on export)` : `${name} — ${t}`;
          })(),
        }),
      );
      fillKeyframes(get, set, path);
      if (media.hasAudio) {
        startJob(get, set, `wave:${path}`, "waveform");
        void invoke<number[]>("waveform", { path })
          .then((peaks) => {
            if (get().project?.sourcePath !== path) return;
            set({ peaks, peaksByPath: { ...get().peaksByPath, [path]: peaks } });
          })
          .catch(() => {})
          .finally(() => endJob(get, set, `wave:${path}`));
      }
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
      filters: [
        { name: "Media", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv", "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus"] },
        { name: "Video", extensions: ["mp4", "mkv", "mov", "avi", "webm", "m4v", "wmv"] },
        { name: "Audio", extensions: ["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff"] },
      ],
    });
    if (typeof path !== "string") return;
    if (AUDIO_RE.test(path) && get().project) {
      await get().addAudio(path);
      return;
    }
    if (AUDIO_RE.test(path) && !get().project) {
      set({ status: "Open a video first, then drop or open audio." });
      return;
    }
    await get().openPath(path);
  },

  dropFile: async (path, at) => {
    if (!isMediaPath(path)) {
      set({ status: "Drop a video or audio file.", dropGhost: null });
      return;
    }
    const start = at ?? get().dropGhost?.start ?? get().playhead;
    set({ dropGhost: null });
    if (!get().project) {
      if (AUDIO_RE.test(path)) {
        set({ status: "Open a video first, then drop audio." });
        return;
      }
      await get().openPath(path);
      return;
    }
    let media = get().mediaByPath[path];
    try {
      if (!media) media = await invoke<MediaInfo>("probe", { path });
    } catch {
      if (AUDIO_RE.test(path)) {
        await get().addAudio(path, start);
        return;
      }
      await get().addOverlay(path, start);
      return;
    }
    if (mediaHasVideo(media)) await get().addOverlay(path, start);
    else if (media.hasAudio) await get().addAudio(path, start);
    else set({ status: "No video or audio in that file." });
  },

  hoverDrop: (path, start) => {
    if (!get().project || !isMediaPath(path)) return;
    const t = Math.max(0, start);
    const prev = get().dropGhost;
    const name = fileName(path);
    const cached = get().mediaByPath[path];
    if (prev?.path === path) {
      if (Math.abs(prev.start - t) < 0.008 && !prev.probing) return;
      set({
        dropGhost: { ...prev, start: t, audioOnly: prev.audioOnly },
        status: `${prev.audioOnly ? "Audio" : "Overlay"} ${name} · ${formatTime(prev.duration || 0)} at ${formatTime(t)}`,
      });
      return;
    }
    set({
      dropGhost: {
        path,
        name,
        duration: cached?.duration ?? 0,
        start: t,
        hasAudio: cached?.hasAudio ?? !AUDIO_RE.test(path),
        audioOnly: cached ? !mediaHasVideo(cached) && !!cached.hasAudio : AUDIO_RE.test(path),
        probing: !cached,
      },
      status: cached
        ? `${!mediaHasVideo(cached) && cached.hasAudio ? "Audio" : "Overlay"} ${name} · ${formatTime(cached.duration)} at ${formatTime(t)}`
        : `Reading ${name}…`,
    });
    if (cached) return;
    void (async () => {
      try {
        const dur = await invoke<number>("probe_quick", { path });
        const g0 = get().dropGhost;
        if (g0?.path === path && Number.isFinite(dur) && dur > 0) {
          set({
            dropGhost: { ...g0, duration: dur },
            status: `Overlay ${name} · ${formatTime(dur)} at ${formatTime(g0.start)}`,
          });
        }
        const media = await invoke<MediaInfo>("probe", { path });
        const g = get().dropGhost;
        if (!g || g.path !== path) return;
        set({
          mediaByPath: { ...get().mediaByPath, [path]: media },
          dropGhost: {
            ...g,
            duration: media.duration,
            hasAudio: media.hasAudio,
            audioOnly: !mediaHasVideo(media) && media.hasAudio,
            probing: false,
          },
          status: `Overlay ${name} · ${formatTime(media.duration)} at ${formatTime(g.start)}`,
        });
        fillKeyframes(get, set, path);
      } catch {
        const g = get().dropGhost;
        if (g?.path === path) set({ dropGhost: { ...g, probing: false }, status: `Couldn’t read ${name}` });
      }
    })();
  },

  clearDropGhost: () => {
    if (get().dropGhost) set({ dropGhost: null });
  },

  addAudio: async (path, at) => {
    const p = get().project;
    if (!p) {
      set({ status: "Open a video first, then drop audio." });
      return;
    }
    const start = Math.max(0, at ?? get().dropGhost?.start ?? get().playhead);
    set({ busy: true, progress: { label: "Importing audio…", pct: 12 }, dropGhost: null, status: "Adding audio…" });
    try {
      let media = get().mediaByPath[path];
      if (!media) media = await invoke<MediaInfo>("probe", { path });
      const r = tryAddAudioFromMedia(get().project!, media, start);
      if (!r.ok) {
        set({ busy: false, progress: null, status: r.error });
        return;
      }
      let peaks = get().peaksByPath[path] ?? [];
      if (media.hasAudio && peaks.length === 0) {
        set({ progress: { label: "Audio waveform…", pct: 55 } });
        try {
          peaks = await invoke<number[]>("waveform", { path });
        } catch {
          peaks = [];
        }
      }
      const audioClips = r.clips.filter((c) => c.kind === "audio");
      const placed =
        audioClips.find((c) => c.sourcePath === (path !== p.sourcePath ? path : undefined)) ??
        audioClips[audioClips.length - 1];
      applyClips(get, set, r.clips, "Add audio");
      set({
        peaksByPath: { ...get().peaksByPath, [path]: peaks },
        mediaByPath: { ...get().mediaByPath, [path]: media },
        previewByPath: { ...get().previewByPath, [path]: convertFileSrc(path) },
        audioPreviewByPath: { ...get().audioPreviewByPath, [path]: convertFileSrc(path) },
        selectedId: placed?.id ?? get().selectedId,
        busy: false,
        progress: null,
        dropGhost: null,
        status: `Audio: ${fileName(path)} at ${formatTime(start)}`,
      });
      fillKeyframes(get, set, path);
    } catch (e) {
      set({ busy: false, progress: null, dropGhost: null, status: String(e) });
    }
  },

  addOverlay: async (path, at) => {
    const p = get().project;
    if (!p) {
      await get().openPath(path);
      return;
    }
    const start = Math.max(0, at ?? get().dropGhost?.start ?? get().playhead);
    set({ busy: true, progress: { label: "Importing overlay…", pct: 12 }, dropGhost: null, status: "Adding overlay…" });
    try {
      let media = get().mediaByPath[path];
      if (!media) media = await invoke<MediaInfo>("probe", { path });
      const r = tryAddOverlayFromMedia(get().project!, media, start);
      if (!r.ok) {
        set({ busy: false, progress: null, status: r.error });
        return;
      }
      let overlayUrl = get().previewByPath[path] ?? convertFileSrc(path);
      if (!get().previewByPath[path]) {
        const urls = await previewUrlsFor(path, media.videoCodec);
        overlayUrl = urls.video;
        set({
          previewByPath: { ...get().previewByPath, [path]: urls.video },
          audioPreviewByPath: { ...get().audioPreviewByPath, [path]: urls.audio },
        });
      }
      const overlayPeaks = get().peaksByPath[path] ?? [];
      const over = [...r.clips].reverse().find((c) => c.layer === "over" && c.kind === "video");
      applyClips(get, set, r.clips, "Overlay (2nd layer)");
      set({
        overlayUrl,
        overlayPeaks,
        overlayMedia: media,
        peaksByPath: { ...get().peaksByPath, [path]: overlayPeaks },
        mediaByPath: { ...get().mediaByPath, [path]: media },
        previewByPath: { ...get().previewByPath, [path]: overlayUrl },
        audioPreviewByPath: {
          ...get().audioPreviewByPath,
          [path]: get().audioPreviewByPath[path] ?? overlayUrl,
        },
        selectedId: over?.id ?? get().selectedId,
        busy: false,
        progress: null,
        dropGhost: null,
        status: `Overlay: ${fileName(path)} at ${formatTime(start)}`,
      });
      fillKeyframes(get, set, path);
      if (media.hasAudio && overlayPeaks.length === 0) {
        startJob(get, set, `wave:${path}`, "waveform");
        void invoke<number[]>("waveform", { path })
          .then((peaks) => {
            if (!get().mediaByPath[path]) return;
            set({
              overlayPeaks: peaks,
              peaksByPath: { ...get().peaksByPath, [path]: peaks },
            });
          })
          .catch(() => {})
          .finally(() => endJob(get, set, `wave:${path}`));
      }
    } catch (e) {
      set({ busy: false, progress: null, dropGhost: null, status: String(e) });
    }
  },

  closeProject: () => {
    set({ playing: false });
    soundUnload();
    void import("../lib/playbackClock").then((m) => m.haltPlayback());
    void invoke("drop_preview_cache").catch(() => {});
    history.clear();
    set(
      syncHist({
        project: null,
        media: null,
        playhead: 0,
        selectedId: null,
        selectedEffectId: null,
        previewUrl: null,
        overlayUrl: null,
        overlayPeaks: [],
        overlayMedia: null,
        peaksByPath: {},
        mediaByPath: {},
        previewByPath: {},
        audioPreviewByPath: {},
        dropGhost: null,
        scrubPreview: null,
        previewOver: false,
        showBlack: false,
        peaks: [],
        range: null,
        clipSel: [],
        playing: false,
        progress: null,
        status: "Drop a video or File → Open…",
        burnSubs: false,
        burnSubIndex: -1,
        subCues: [],
        subStyle: { ...DEFAULT_SUB_STYLE },
      }),
    );
  },

  setPlayhead: (t, opts) => {
    const p = get().project;
    if (!p) return null;
    const max = rulerDuration(p);
    const playhead = Math.max(0, Math.min(max, t));
    const hit = clipAt(p, playhead, "video");
    const mapped = mapTimelineToSource(p, playhead);
    // A clip the user picked stays picked while the playhead is still on it — passing over an
    // overlay must not steal the selection from the main track.
    const cur = p.clips.find((c) => c.id === get().selectedId);
    const stays = !!cur && playhead >= cur.timelineStart - 0.001 && playhead <= clipEnd(cur) + 0.001;
    set({
      playhead,
      selectedId: opts?.keepSelection || stays ? get().selectedId : (hit?.id ?? get().selectedId),
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
    const keyId = get().selectedAnimId;
    if (keyId) {
      const host = get().project?.clips.find((c) => c.anim?.some((k) => k.id === keyId));
      const range = get().range;
      const rangeOn = !!range && Math.abs(range.end - range.start) > 0.04;
      if (host && !get().clipSel.length && !rangeOn) {
        get().removeAnimKey(host.id, keyId);
        return;
      }
    }
    const spans = get().clipSel;
    if (spans.length) {
      const p = get().project;
      if (!p) return;
      const r = tryDeleteSpans(p, spans);
      if (!r.ok) {
        set({ status: r.error });
        return;
      }
      applyClips(get, set, r.clips, "Delete selection");
      set({ clipSel: [], range: null });
      return;
    }
    const fxId = get().selectedEffectId;
    if (fxId) {
      const p = get().project;
      if (!p) return;
      const clips = p.clips.map((c) => {
        if (!c.effects?.some((e) => e.id === fxId)) return c;
        return { ...c, effects: (c.effects ?? []).filter((e) => e.id !== fxId) };
      });
      applyClips(get, set, clips, "Remove effect");
      set({ selectedEffectId: null });
      return;
    }
    const span = get().range;
    if (span && Math.abs(span.end - span.start) > 0.04) {
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

  select: (id) =>
    set({
      selectedId: id,
      editingTextId: id && id === get().editingTextId ? get().editingTextId : null,
      selectedEffectId: null,
      selectedAnimId: null,
    }),

  selectEffect: (clipId, effectId) =>
    set({
      selectedId: clipId,
      selectedEffectId: effectId,
      editingTextId: null,
      selectedAnimId: null,
    }),

  addEffect: (kind) => {
    const p = get().project;
    if (!p) return;
    let clip = p.clips.find((c) => c.id === get().selectedId);
    if (!clip || clip.kind === "audio") {
      clip = p.clips.find(
        (c) =>
          (c.kind === "video" || c.kind === "text") &&
          get().playhead >= c.timelineStart &&
          get().playhead < c.timelineStart + (c.sourceEnd - c.sourceStart),
      );
    }
    if (!clip || clip.kind === "audio") {
      set({ status: "Select a video or text clip to add an effect" });
      return;
    }
    const existing = clip.effects?.find((e) => e.kind === kind);
    if (existing) {
      set({
        selectedId: clip.id,
        selectedEffectId: existing.id,
        editingTextId: null,
        status: "Blur selected",
      });
      return;
    }
    const fx: ClipEffect = { id: newId(), kind, amount: 8 };
    const clips = p.clips.map((c) => (c.id === clip!.id ? { ...c, effects: [...(c.effects ?? []), fx] } : c));
    applyClips(get, set, clips, "Gaussian blur");
    set({ selectedId: clip.id, selectedEffectId: fx.id, editingTextId: null });
  },

  setEffectAmount: (effectId, amount) => {
    const p = get().project;
    if (!p) return;
    const n = Math.max(0, Math.min(100, amount));
    set({
      project: {
        ...p,
        clips: p.clips.map((c) => ({
          ...c,
          effects: c.effects?.map((e) => (e.id === effectId ? { ...e, amount: n } : e)),
        })),
      },
    });
  },

  liveTrim: (id, edge, sourceEdge, snapSec = 0.12, from) => {
    const p = get().project;
    if (!p) return;
    const src = { ...p, clips: from ?? p.clips };
    const clip = src.clips.find((c) => c.id === id);
    if (!clip) return;
    const kfs = get().media?.keyframeTimes ?? [];
    let snapped = snapToKeyframe(sourceEdge, kfs, snapSec);
    const ignore = new Set<string>([id]);
    if (clip.linkGroup) {
      for (const c of src.clips) if (c.linkGroup === clip.linkGroup) ignore.add(c.id);
    }
    const t = clip.timelineStart + (snapped - clip.sourceStart);
    const t2 = snapEdge(src, ignore, t, snapSec);
    snapped = clip.sourceStart + (t2 - clip.timelineStart);
    const r = tryTrim(src, id, edge, snapped);
    if (r.ok) set({ project: { ...p, clips: r.clips } });
  },

  liveMove: (id, timelineStart, snapSec = 0.12, from) => {
    const p = get().project;
    if (!p) return;
    const src = { ...p, clips: from ?? p.clips };
    const clip = src.clips.find((c) => c.id === id);
    if (!clip) return;
    const kfs = get().media?.keyframeTimes ?? [];
    let best = snapStart(src, clip, timelineStart, snapSec);
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
      for (const other of src.clips) {
        if (other.id === clip.id) continue;
        consider(other.timelineStart - offset);
        consider(other.timelineStart + (other.sourceEnd - other.sourceStart) - offset);
      }
      consider(-offset);
    }
    const r = tryMove(src, id, best);
    if (r.ok) set({ project: { ...p, clips: r.clips } });
  },

  liveMoveSel: (id, origStart, proposedStart, snapSec, from, seedIds) => {
    const p = get().project;
    if (!p) return;
    const src = { ...p, clips: from };
    const clip = src.clips.find((c) => c.id === id);
    if (!clip) return;
    let delta = proposedStart - origStart;
    const snapped = snapStart(src, clip, clip.timelineStart + delta, snapSec);
    delta = snapped - clip.timelineStart;
    const r = tryMoveIds(src, new Set(seedIds), delta);
    if (!r.ok) return;
    const sel = seedIds
      .map((cid) => {
        const c = r.clips.find((x) => x.id === cid);
        if (!c) return null;
        return { clipId: c.id, start: c.timelineStart, end: c.timelineStart + (c.sourceEnd - c.sourceStart) };
      })
      .filter((x): x is ClipSpan => !!x);
    set({ project: { ...p, clips: r.clips }, clipSel: sel });
  },

  commit: (before, label) => {
    const p = get().project;
    if (!p) return;
    history.push(before, p.clips, label);
    set(syncHist({ status: `${label} · ${formatTime(timelineDuration(p))}` }));
  },

  applyEdit: (clips, label) => applyClips(get, set, clips, label),

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

  linkPair: (aId, bId) => {
    const p = get().project;
    if (!p) return;
    const r = tryLinkPair(p, aId, bId);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    applyClips(get, set, r.clips, "Link A/V");
  },

  setRange: (range) => set({ range }),
  setClipSel: (spans) => {
    const next = mergeSpans(spans);
    set({ clipSel: next, gainDraft: 0, selLane: next.length ? get().selLane : null });
  },

  copyRange: () => {
    const p = get().project;
    const range = get().range;
    if (!p || !range) {
      const id = get().selectedId;
      const c = p?.clips.find((x) => x.id === id);
      if (c) {
        set({
          clipboard: {
            kind: c.kind,
            sourceStart: c.sourceStart,
            sourceEnd: c.sourceEnd,
            sourcePath: c.sourcePath,
            consume: false,
          },
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
    set({ clipboard: { ...chunk, consume: false }, status: `Copied ${chunk.kind} ${formatTime(chunk.sourceEnd - chunk.sourceStart)}` });
  },

  cutOrSlice: () => {
    const p = get().project;
    if (!p) return;
    const sel = get().clipSel;
    if (sel.length) {
      const c = p.clips.find((x) => x.id === sel[0].clipId);
      const s = sel[0];
      const chunk =
        c && s
          ? {
              kind: c.kind,
              sourceStart: c.sourceStart + (Math.max(s.start, c.timelineStart) - c.timelineStart),
              sourceEnd: c.sourceStart + (Math.min(s.end, clipEnd(c)) - c.timelineStart),
              sourcePath: c.sourcePath,
              consume: true,
            }
          : null;
      get().del();
      if (chunk && chunk.sourceEnd - chunk.sourceStart > 0.04) {
        set({ clipboard: chunk, status: `Cut ${formatTime(chunk.sourceEnd - chunk.sourceStart)} — paste to place` });
      }
      return;
    }
    const range = get().range;
    if (range && Math.abs(range.end - range.start) > 0.04) {
      get().liftRange();
      return;
    }
    get().slice();
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
      clipboard: chunk ? { ...chunk, consume: true } : null,
      range: null,
      status: chunk
        ? `Cut ${formatTime(dur)} — click paste once to place it`
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
      clipboard: null,
      selectedId: added?.id ?? get().selectedId,
      status: added?.layer === "over" ? "Pasted on overlay (2nd layer)" : "Pasted",
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

  setCanvas: (w, h) => {
    const p = get().project;
    if (!p) return;
    const canvasWidth = evenPx(w, p.canvasWidth);
    const canvasHeight = evenPx(h, p.canvasHeight);
    set({ project: { ...p, canvasWidth, canvasHeight }, status: `Canvas ${canvasWidth}×${canvasHeight}` });
    requestAnimationFrame(() => {
      void fitWindowToVideo(canvasWidth, canvasHeight);
    });
  },

  setCanvasPreset: (id) => {
    const list = RES_BY_AR[id];
    const fallback = AR_PRESETS.find((x) => x.id === id);
    const pick = list?.find((r) => Math.min(r.w, r.h) === 1080) ?? list?.[2] ?? list?.[0] ?? fallback;
    if (!pick) return;
    get().setCanvas(pick.w, pick.h);
  },

  setPreviewVolume: (v) => set({ previewVolume: Math.max(0, Math.min(1, v)) }),

  selectedAnimId: null,
  selectAnimKey: (clipId, keyId) =>
    set({
      selectedAnimId: keyId,
      selectedId: clipId ?? get().selectedId,
      selectedEffectId: keyId ? null : get().selectedEffectId,
      ...(keyId ? { clipSel: [], range: null } : {}),
    }),
  addAnimKey: (id) => {
    const p = get().project;
    if (!p) return;
    const c = id ? p.clips.find((x) => x.id === id) : motionTarget(p.clips, get().playhead, get().selectedId);
    if (!c || c.kind === "audio") {
      set({ status: "Park the playhead on a video or text clip" });
      return;
    }
    const local = get().playhead - c.timelineStart;
    if (local < -0.001 || local > clipDuration(c) + 0.001) {
      set({ status: "Park the playhead on that clip" });
      return;
    }
    const t = Math.max(0, Math.min(clipDuration(c), local));
    const pose = poseAt(c, c.timelineStart + t);
    const near = nearestAnim(c.anim, t, 0.06);
    const key = maskAnimWrite(near, animFromPose(near?.id ?? newId(), near?.t ?? t, pose));
    const anim = near ? (c.anim ?? []).map((k) => (k.id === near.id ? key : k)) : [...(c.anim ?? []), key];
    applyClips(
      get,
      set,
      p.clips.map((x) => (x.id === c.id ? { ...x, anim, transform: pose } : x)),
      "Motion key",
    );
    set({
      selectedAnimId: key.id,
      selectedId: c.id,
      status: `Motion key on ${layerName(c)} — move the playhead and pose again`,
    });
  },
  stepAnimKey: (dir) => {
    const p = get().project;
    if (!p) return;
    const keyId = get().selectedAnimId;
    const c =
      (keyId ? p.clips.find((x) => x.anim?.some((k) => k.id === keyId)) : undefined) ??
      motionTarget(p.clips, get().playhead, get().selectedId);
    if (!c?.anim?.length) {
      set({ status: "No motion keys on this clip yet" });
      return;
    }
    const from = c.anim.find((x) => x.id === keyId);
    const k = stepKey(c, from ? c.timelineStart + from.t : get().playhead, dir);
    if (!k) {
      set({ status: dir > 0 ? "Last motion key" : "First motion key" });
      return;
    }
    get().setPlayhead(c.timelineStart + k.t, { keepSelection: true });
    get().selectAnimKey(c.id, k.id);
  },
  moveAnimKey: (clipId, keyId, t) => {
    const p = get().project;
    if (!p) return;
    set({
      project: {
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== clipId) return c;
          const tt = Math.max(0, Math.min(clipDuration(c), t));
          return { ...c, anim: (c.anim ?? []).map((k) => (k.id === keyId ? { ...k, t: tt } : k)) };
        }),
      },
    });
  },
  removeAnimKey: (clipId, keyId) => {
    const p = get().project;
    if (!p) return;
    applyClips(
      get,
      set,
      p.clips.map((c) => (c.id === clipId ? { ...c, anim: (c.anim ?? []).filter((k) => k.id !== keyId) } : c)),
      "Remove key",
    );
    if (get().selectedAnimId === keyId) set({ selectedAnimId: null });
  },
  setAnimChannels: (clipId, keyId, patch) => {
    const p = get().project;
    if (!p) return;
    applyClips(
      get,
      set,
      p.clips.map((c) => {
        if (c.id !== clipId) return c;
        return {
          ...c,
          anim: (c.anim ?? []).map((k) =>
            k.id === keyId ? { ...k, channels: { ...k.channels, ...patch } } : k,
          ),
        };
      }),
      "Motion key",
    );
  },
  liveTransform: (id, xf, write) => {
    const p = get().project;
    if (!p) return;
    const ph = get().playhead;
    set({
      project: {
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== id) return c;
          const prev = c.transform ?? xf;
          const transform = writeTransform(prev, xf, write);
          if (!(c.anim?.length)) return { ...c, transform };
          const t = Math.max(0, Math.min(clipDuration(c), ph - c.timelineStart));
          const near = nearestAnim(c.anim, t, 0.08);
          const posed = animFromPose(near?.id ?? newId(), near?.t ?? t, near ? writeTransform(near, xf, write) : xf);
          const key = maskAnimWrite(near, posed);
          const anim = near ? c.anim.map((k) => (k.id === near.id ? key : k)) : [...c.anim, key];
          return { ...c, anim, transform };
        }),
      },
    });
  },

  setEditingText: (id) => set({ editingTextId: id, selectedId: id ?? get().selectedId }),

  setTextProps: (id, patch, opts) => {
    const p = get().project;
    if (!p) return;
    const hug = opts?.hug !== false;
    const typed = "text" in patch || "fontFamily" in patch || "fontSize" in patch || "textAlign" in patch;
    set({
      project: {
        ...p,
        clips: p.clips.map((c) => {
          if (c.id !== id) return c;
          let next: Clip = { ...c, ...patch };
          if ("fontSize" in patch && next.transform) {
            next = {
              ...next,
              transform: { ...next.transform, scale: 1, scaleX: 1, scaleY: 1 },
            };
          }
          if (hug && typed && !("boxW" in patch) && !("boxH" in patch) && next.kind === "text") {
            next = hugTextClip(next);
          }
          return next;
        }),
      },
    });
  },

  hugText: (id) => {
    const p = get().project;
    if (!p) return;
    set({
      project: {
        ...p,
        clips: p.clips.map((c) => (c.id === id && c.kind === "text" ? hugTextClip(c) : c)),
      },
    });
  },

  addTextClip: () => {
    const p = get().project;
    if (!p) return;
    const r = tryAddText(p, get().playhead);
    if (!r.ok) {
      set({ status: r.error });
      return;
    }
    const added = r.clips.find((c) => c.kind === "text" && !p.clips.some((o) => o.id === c.id));
    const clips = added ? r.clips.map((c) => (c.id === added.id ? hugTextClip(c) : c)) : r.clips;
    applyClips(get, set, clips, "Text layer");
    set({
      selectedId: added?.id ?? get().selectedId,
      editingTextId: added?.id ?? null,
      status: "Text layer — type on the canvas",
    });
  },

  burnSubs: false,
  burnSubIndex: -1,
  subCues: [],
  subStyle: { ...DEFAULT_SUB_STYLE },
  exportCodecs: [],
  exportCodecsReady: false,
  primeExportCodecs: () => {
    if (get().exportCodecsReady) return;
    void invoke<{ id: string; label: string }[]>("list_export_codecs")
      .then((list) => set({ exportCodecs: list.length ? list : [{ id: "h264", label: "H.264" }], exportCodecsReady: true }))
      .catch(() => set({ exportCodecs: [{ id: "h264", label: "H.264" }], exportCodecsReady: true }));
  },
  setSubStyle: (patch) => set({ subStyle: { ...get().subStyle, ...patch } }),
  setBurnSubs: (on) => set({ burnSubs: on, subCues: on ? get().subCues : [] }),
  setBurnSubIndex: (index) => {
    set({ burnSubIndex: index, burnSubs: true });
    const p = get().project;
    const media = get().media;
    if (!p || !media) return;
    const track = textSubtitleTracks(media).find((s) => s.index === index);
    if (!track) {
      set({ subCues: [] });
      return;
    }
    const src = p.sourcePath;
    startJob(get, set, "subs", "subtitles");
    void invoke<SubCue[]>("extract_subtitles", {
      path: src,
      stream: track.index >= 0 ? track.index : null,
      sidecar: track.sidecar ?? null,
    })
      .then((cues) => {
        if (get().project?.sourcePath !== src || get().burnSubIndex !== index) return;
        set({ subCues: cues, status: cues.length ? `Subtitles: ${cues.length} cues` : "No subtitle cues in that track" });
      })
      .catch((e) => {
        if (get().project?.sourcePath !== src) return;
        set({ subCues: [], status: String(e) });
      })
      .finally(() => endJob(get, set, "subs"));
  },

  saveProject: () => {
    if (!get().project) {
      set({ status: "Nothing to save." });
      return;
    }
    set({ status: "Project save coming later." });
  },

  exportVideo: async (opts) => {
    const { project, media, busy, burnSubs, burnSubIndex, subStyle } = get();
    if (!project || !media || busy) return;
    const profile = opts?.profile ?? "quick";
    const suggested = await invoke<string>("suggest_save", { path: project.sourcePath });
    const dest =
      opts?.outputPath ||
      (await save({
        defaultPath: suggested.replace(/\.(webm|gif)$/i, ".mp4"),
        filters: [
          { name: "MP4", extensions: ["mp4"] },
          { name: "MKV", extensions: ["mkv"] },
        ],
      }));
    if (!dest) return;
    const clips = flattenKind(project, "video");
    const audioClips = flattenKind(project, "audio", "base");
    const audioOverlay = flattenKind(project, "audio", "over");
    const hasAudioClips = project.clips.some((c) => c.kind === "audio");
    const hasOverAudio = project.clips.some((c) => c.kind === "audio" && c.layer === "over");
    const videoClips = project.clips.filter((c) => c.kind === "video");
    const compSlices = flattenCanvas(project, media, get().mediaByPath);
    const hasGap = clips.some((c) => c.gap) || audioClips.some((c) => c.gap) || audioOverlay.some((c) => c.gap);
    const otherFile =
      clips.some((s) => !s.gap && s.sourcePath !== project.sourcePath) ||
      audioClips.some((s) => !s.gap && s.sourcePath && s.sourcePath !== project.sourcePath) ||
      audioOverlay.some((s) => !s.gap && s.sourcePath && s.sourcePath !== project.sourcePath);
    const fancy =
      compSlices.some((s) => s.layers.length !== 1) ||
      videoClips.some((c) => {
        const xf = c.transform;
        return (
          clipBlur(c) > 0.05 ||
          (xf &&
            (xf.x !== 0 ||
              xf.y !== 0 ||
              xf.scale !== 1 ||
              xf.rotation !== 0 ||
              (xf.scaleX != null && xf.scaleX !== xf.scale) ||
              (xf.scaleY != null && xf.scaleY !== xf.scale)))
        );
      }) ||
      project.clips.some((c) => clipBlur(c) > 0.05) ||
      project.canvasWidth !== (media.width || project.canvasWidth) ||
      project.canvasHeight !== (media.height || project.canvasHeight);
    const mediaOnly = (segs: typeof clips) =>
      segs.filter((s) => !s.gap).map((s) => ({ sourceStart: s.sourceStart, sourceEnd: s.sourceEnd }));
    const subTrack = textSubtitleTracks(media).find((s) => s.index === burnSubIndex);
    const willBurn = burnSubs && !!subTrack;
    const useStreamCopy =
      profile === "quick" &&
      !willBurn &&
      !hasGap &&
      !otherFile &&
      !fancy &&
      hasAudioClips &&
      !hasOverAudio &&
      !project.clips.some(
        (c) => c.kind === "audio" && (Math.abs(c.gainDb ?? 0) > 0.05 || (c.gainSpans && c.gainSpans.length > 0)),
      ) &&
      canStreamCopyAllClips(videoClips, media.keyframeTimes, media.frameRate) &&
      mediaOnly(audioClips).length === mediaOnly(clips).length;
    let outW = opts?.width ?? project.canvasWidth;
    let outH = opts?.height ?? project.canvasHeight;
    let videoBitrate: string | null = null;
    let audioBitrate = opts?.audioBitrate ?? "192k";
    let encoder = opts?.encoder ?? "auto";
    let crf = opts?.crf ?? null;
    let x264Preset = opts?.preset ?? null;
    if (profile === "youtube") {
      const fps = media.frameRate || 30;
      const area = Math.max(1, outW * outH) / (1920 * 1080);
      const base = fps > 40 ? 12 : 8;
      const mbps = Math.min(50, Math.max(2.5, Math.round(base * area * 10) / 10));
      videoBitrate = `${mbps}M`;
      audioBitrate = "384k";
      encoder = "auto";
    } else if (profile === "discord") {
      const dur = Math.max(timelineDuration(project), 0.5);
      const limitBits = 10 * 1000 * 1000 * 8;
      const audioBps = 128_000;
      let vBits = Math.max(400_000, limitBits / dur - audioBps);
      if (vBits < 700_000) {
        const s = scaleToMaxH(outW, outH, 480);
        outW = s.w;
        outH = s.h;
      } else if (vBits < 1_400_000) {
        const s = scaleToMaxH(outW, outH, 720);
        outW = s.w;
        outH = s.h;
      }
      vBits = Math.min(vBits, 6_000_000);
      videoBitrate = `${Math.round(vBits / 1000)}k`;
      audioBitrate = "128k";
    }
    const label =
      profile === "discord"
        ? "Exporting for Discord…"
        : profile === "youtube"
          ? "Exporting for YouTube…"
          : useStreamCopy
            ? "Saving (stream copy)…"
            : "Saving…";
    set({
      busy: true,
      progress: { label, pct: 12 },
      status: label,
    });
    try {
      const result = await invoke<{ message: string; outputPath: string }>("export_video", {
        plan: {
          sourcePath: project.sourcePath,
          outputPath: dest,
          clips,
          audioClips,
          audioOverlay: hasOverAudio ? audioOverlay : [],
          hasAudio: hasAudioClips,
          videoCodec: media.videoCodec,
          useStreamCopy,
          width: outW,
          height: outH,
          frameRate: media.frameRate,
          compSlices,
          profile,
          videoBitrate,
          audioBitrate,
          crf,
          encoder: encoder === "auto" ? null : encoder,
          x264Preset,
          burnSubs: willBurn,
          subtitleStream: willBurn && subTrack && subTrack.index >= 0 ? subTrack.index : null,
          subtitleFile: willBurn ? (subTrack?.sidecar ?? null) : null,
          subtitleFont: subStyle.fontFamily,
          subtitleColor: subStyle.color,
          subtitleSize: subStyle.fontSize,
          subtitleShadow: subStyle.shadow,
          subtitleStroke: subStyle.stroke,
        },
      });
      set({ busy: false, progress: null, status: `Saved: ${result.outputPath} · ${result.message}` });
    } catch (e) {
      const text = String(e).replace(/^Error:\s*/i, "");
      const short = text.split("\n").filter(Boolean).slice(-1)[0] ?? text;
      if (/cancel/i.test(short)) {
        set({ busy: false, progress: null, status: "Export cancelled." });
        return;
      }
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

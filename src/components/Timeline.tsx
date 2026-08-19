import { useEffect, useRef, type MouseEvent } from "react";
import { clipDuration, formatTime, type Clip, type ClipKind } from "../core/types";
import { clipsOn, rulerDuration, timelineDuration } from "../core/project";
import { useEditor } from "../store/editorStore";
import { Waveform } from "./Waveform";

type Drag =
  | { kind: "seek" }
  | { kind: "pan"; startX: number; view0: number }
  | { kind: "box"; track: ClipKind; a: number; b: number }
  | {
      kind: "move" | "trimL" | "trimR";
      id: string;
      startX: number;
      orig: number;
      before: Clip[];
    };

function seekVideo(t: number) {
  const src = useEditor.getState().setPlayhead(t);
  const v = document.querySelector("video");
  if (v && src != null) v.currentTime = src;
}

export function Timeline() {
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const zoom = useEditor((s) => s.zoom);
  const range = useEditor((s) => s.range);
  const peaks = useEditor((s) => s.peaks);
  const busy = useEditor((s) => s.busy);

  useEffect(() => {
    const el = scroller.current;
    const wheel = (e: globalThis.WheelEvent) => {
      e.preventDefault();
      const t = timeAt(e.clientX);
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const factor = e.deltaY > 0 ? 0.85 : 1.18;
        useEditor.getState().setZoom(useEditor.getState().zoom * factor, t);
      } else if (el) {
        el.scrollLeft += e.deltaX || e.deltaY;
      }
    };
    el?.addEventListener("wheel", wheel, { passive: false });
    const onUp = () => {
      const d = drag.current;
      if (!d) return;
      if (d.kind === "move" || d.kind === "trimL" || d.kind === "trimR") {
        useEditor.getState().commit(d.before, d.kind === "move" ? "Move" : "Trim");
      }
      if (d.kind === "box") {
        const a = Math.min(d.a, d.b);
        const b = Math.max(d.a, d.b);
        useEditor.getState().setRange(b - a > 0.04 ? { start: a, end: b, kind: d.track } : null);
      }
      drag.current = null;
    };
    window.addEventListener("mouseup", onUp);
    return () => {
      el?.removeEventListener("wheel", wheel);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  if (!project) return null;

  const total = rulerDuration(project);
  const pps = zoom;
  const width = Math.max(total * pps, 1);

  const timeAt = (clientX: number) => {
    const el = scroller.current;
    if (!el) return 0;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    return Math.max(0, x / pps);
  };

  const onMove = (e: MouseEvent) => {
    const d = drag.current;
    if (!d) return;
    const t = timeAt(e.clientX);
    if (d.kind === "seek") {
      seekVideo(t);
      return;
    }
    if (d.kind === "box") {
      drag.current = { ...d, b: t };
      useEditor.getState().setRange({ start: Math.min(d.a, t), end: Math.max(d.a, t), kind: d.track });
      return;
    }
    if (d.kind === "pan" && scroller.current) {
      scroller.current.scrollLeft = d.view0 - (e.clientX - d.startX);
      return;
    }
    const delta = (e.clientX - d.startX) / pps;
    const st = useEditor.getState();
    if (d.kind === "trimL") st.liveTrim(d.id, "left", d.orig + delta);
    if (d.kind === "trimR") st.liveTrim(d.id, "right", d.orig + delta);
    if (d.kind === "move") st.liveMove(d.id, d.orig + delta);
  };

  const startBox = (kind: ClipKind, e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".clip, .handle, .playhead-hit, .link-btn")) return;
    if (e.button === 1 || e.altKey) {
      drag.current = { kind: "pan", startX: e.clientX, view0: scroller.current?.scrollLeft ?? 0 };
      return;
    }
    // Empty-lane drag = range box. Playhead via playhead handle or click-without-drag.
    const t = timeAt(e.clientX);
    drag.current = { kind: "box", track: kind, a: t, b: t };
    useEditor.getState().setRange({ start: t, end: t, kind });
    seekVideo(t);
  };

  const startEdit = (kind: "move" | "trimL" | "trimR", clip: Clip, e: MouseEvent, orig: number) => {
    e.stopPropagation();
    useEditor.getState().select(clip.id);
    drag.current = {
      kind,
      id: clip.id,
      startX: e.clientX,
      orig,
      before: useEditor.getState().snapshot() ?? [],
    };
  };

  const renderLane = (kind: ClipKind) => {
    const base = clipsOn(project, kind, "base");
    const over = clipsOn(project, kind, "over");
    return (
      <div
        className={`lane lane-${kind}`}
        onMouseDown={(e) => startBox(kind, e)}
        onDoubleClick={(e) => {
          const t = timeAt(e.clientX);
          useEditor.getState().slice(t);
        }}
      >
        <div className="lane-label">{kind === "video" ? "V" : "A"}</div>
        <div className="lane-body" style={{ width }}>
          {base.map((c) => (
            <ClipView
              key={c.id}
              clip={c}
              pps={pps}
              selected={c.id === selectedId}
              peaks={kind === "audio" ? peaks : []}
              sourceDuration={project.sourceDuration}
              onMove={(e) => startEdit("move", c, e, c.timelineStart)}
              onTrimL={(e) => startEdit("trimL", c, e, c.sourceStart)}
              onTrimR={(e) => startEdit("trimR", c, e, c.sourceEnd)}
            />
          ))}
          {over.map((c) => (
            <ClipView
              key={c.id}
              clip={c}
              pps={pps}
              selected={c.id === selectedId}
              overlay
              peaks={kind === "audio" ? peaks : []}
              sourceDuration={project.sourceDuration}
              onMove={(e) => startEdit("move", c, e, c.timelineStart)}
              onTrimL={(e) => startEdit("trimL", c, e, c.sourceStart)}
              onTrimR={(e) => startEdit("trimR", c, e, c.sourceEnd)}
            />
          ))}
          {range && range.kind === kind ? (
            <div
              className="range-box"
              style={{
                left: Math.min(range.start, range.end) * pps,
                width: Math.abs(range.end - range.start) * pps,
              }}
            />
          ) : null}
        </div>
      </div>
    );
  };

  const selected = project.clips.find((c) => c.id === selectedId);

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span>
          {formatTime(playhead)} / {formatTime(timelineDuration(project))} · scroll zoom
        </span>
        <div className="timeline-actions">
          <button type="button" title="Slice at playhead (S / double-click)" onClick={() => useEditor.getState().slice()}>
            Slice
          </button>
          <button type="button" disabled={!selected} onClick={() => useEditor.getState().del()}>
            Delete
          </button>
          <button
            type="button"
            className={selected?.linkGroup ? "is-on" : ""}
            disabled={!selected}
            title="Link / unlink video & audio"
            onClick={() => selected && useEditor.getState().toggleLink(selected.id)}
          >
            {selected?.linkGroup ? "Linked" : "Unlinked"}
          </button>
          <button type="button" onClick={() => useEditor.getState().copyRange()}>
            Copy
          </button>
          <button type="button" onClick={() => useEditor.getState().paste()}>
            Paste
          </button>
          <button type="button" disabled={!useEditor.getState().canUndo} onClick={() => useEditor.getState().undo()}>
            Undo
          </button>
          <button type="button" disabled={!useEditor.getState().canRedo} onClick={() => useEditor.getState().redo()}>
            Redo
          </button>
          <button type="button" disabled={busy} onClick={() => void useEditor.getState().exportVideo()}>
            Save…
          </button>
        </div>
      </div>
      <div ref={scroller} className="tl-scroll" onMouseMove={onMove}>
        {renderLane("video")}
        {renderLane("audio")}
        <div
          className="playhead-hit"
          style={{ left: playhead * pps + 22 }}
          onMouseDown={(e) => {
            e.stopPropagation();
            seekVideo(timeAt(e.clientX));
            drag.current = { kind: "seek" };
          }}
        />
        <div className="playhead-full" style={{ left: playhead * pps + 22 }} />
      </div>
      <div className="timeline-foot">
        <span>Drag ends to trim · drag clip to move (snaps) · Shift+drag range · double-click / S slice · Ctrl+C/V</span>
        <span>{zoom.toFixed(0)} px/s</span>
      </div>
    </div>
  );
}

function ClipView({
  clip,
  pps,
  selected,
  overlay,
  peaks,
  sourceDuration,
  onMove,
  onTrimL,
  onTrimR,
}: {
  clip: Clip;
  pps: number;
  selected: boolean;
  overlay?: boolean;
  peaks: number[];
  sourceDuration: number;
  onMove: (e: MouseEvent) => void;
  onTrimL: (e: MouseEvent) => void;
  onTrimR: (e: MouseEvent) => void;
}) {
  return (
    <div
      className={`clip ${clip.kind}${selected ? " selected" : ""}${overlay ? " overlay" : ""}`}
      style={{
        left: clip.timelineStart * pps,
        width: Math.max(clipDuration(clip) * pps, 8),
      }}
      onMouseDown={onMove}
      title={`${clip.kind} ${overlay ? "overlay" : "base"} ${formatTime(clipDuration(clip))}`}
    >
      <div className="handle left" onMouseDown={onTrimL} />
      {clip.kind === "audio" ? <Waveform clip={clip} peaks={peaks} sourceDuration={sourceDuration} /> : (
        <span className="clip-label">{formatTime(clipDuration(clip))}</span>
      )}
      {clip.linkGroup ? <span className="link-dot" title="Linked A/V" /> : null}
      <div className="handle right" onMouseDown={onTrimR} />
    </div>
  );
}

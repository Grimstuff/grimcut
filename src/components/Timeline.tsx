import { useRef, type MouseEvent } from "react";
import { clipDuration, formatTime } from "../core/types";
import { rulerDuration, timelineDuration } from "../core/project";
import { useEditor } from "../store/editorStore";

export function Timeline() {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: "seek" }
    | { kind: "move" | "trimL" | "trimR"; id: string; startX: number; orig: number; before: ReturnType<NonNullable<ReturnType<typeof useEditor.getState>["snapshot"]>> }
    | null
  >(null);

  const project = useEditor((s) => s.project);
  const media = useEditor((s) => s.media);
  const playhead = useEditor((s) => s.playhead);
  const selectedId = useEditor((s) => s.selectedId);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const select = useEditor((s) => s.select);
  const cut = useEditor((s) => s.cut);
  const del = useEditor((s) => s.del);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const exportVideo = useEditor((s) => s.exportVideo);
  const busy = useEditor((s) => s.busy);
  const videoRefSeek = (t: number) => {
    const src = setPlayhead(t, true);
    const v = document.querySelector("video");
    if (v && src != null) v.currentTime = src;
  };

  if (!project) return null;

  const ruler = rulerDuration(project);
  const widthOf = (el: HTMLElement) => el.clientWidth || 1;

  const timeAt = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return x * ruler;
  };

  const onTrackDown = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest(".clip, .handle, .playhead-hit")) return;
    videoRefSeek(timeAt(e.clientX));
    drag.current = { kind: "seek" };
  };

  const onMove = (e: MouseEvent) => {
    const d = drag.current;
    if (!d || !trackRef.current) return;
    const pps = widthOf(trackRef.current) / ruler;
    if (d.kind === "seek") {
      videoRefSeek(timeAt(e.clientX));
      return;
    }
    const delta = (e.clientX - d.startX) / pps;
    const st = useEditor.getState();
    if (d.kind === "trimL") st.liveTrimLeft(d.id, d.orig + delta);
    if (d.kind === "trimR") st.liveTrimRight(d.id, d.orig + delta);
    if (d.kind === "move") st.liveMove(d.id, d.orig + delta);
  };

  const endDrag = () => {
    const d = drag.current;
    if (d && d.kind !== "seek" && d.before) {
      useEditor.getState().commit(d.before, d.kind === "move" ? "Move" : "Trim");
    }
    drag.current = null;
  };

  const startEdit = (kind: "move" | "trimL" | "trimR", id: string, e: MouseEvent, orig: number) => {
    e.stopPropagation();
    select(id);
    drag.current = { kind, id, startX: e.clientX, orig, before: useEditor.getState().snapshot() };
  };

  return (
    <div className="timeline">
      <div className="timeline-head">
        <span>
          Timeline · {project.segments.length} clip(s) · {formatTime(timelineDuration(project))}
        </span>
        <div className="timeline-actions">
          <button type="button" onClick={cut}>Cut</button>
          <button type="button" onClick={del}>Delete</button>
          <button type="button" disabled={!canUndo} onClick={undo}>Undo</button>
          <button type="button" disabled={!canRedo} onClick={redo}>Redo</button>
          <button type="button" disabled={busy} onClick={() => void exportVideo()}>Save…</button>
        </div>
      </div>
      <div
        ref={trackRef}
        className="track"
        onMouseDown={onTrackDown}
        onMouseMove={onMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
      >
        {project.segments.map((s) => {
          const left = (s.timelineStart / ruler) * 100;
          const w = (clipDuration(s) / ruler) * 100;
          return (
            <div
              key={s.id}
              className={`clip${s.id === selectedId ? " selected" : ""}`}
              style={{ left: `${left}%`, width: `${Math.max(w, 0.8)}%` }}
              onMouseDown={(e) => startEdit("move", s.id, e, s.timelineStart)}
            >
              <div className="handle left" onMouseDown={(e) => startEdit("trimL", s.id, e, s.sourceStart)} />
              {formatTime(clipDuration(s))}
              <div className="handle right" onMouseDown={(e) => startEdit("trimR", s.id, e, s.sourceEnd)} />
            </div>
          );
        })}
        {(media?.keyframeTimes ?? []).map((kf) =>
          project.segments.map((s) => {
            if (kf < s.sourceStart || kf >= s.sourceEnd) return null;
            const tl = s.timelineStart + (kf - s.sourceStart);
            return <div key={`${s.id}-${kf}`} className="kf" style={{ left: `${(tl / ruler) * 100}%` }} />;
          }),
        )}
        <div
          className="playhead-hit"
          style={{ left: `${(playhead / ruler) * 100}%` }}
          onMouseDown={(e) => {
            e.stopPropagation();
            videoRefSeek(timeAt(e.clientX));
            drag.current = { kind: "seek" };
          }}
        />
        <div className="playhead" style={{ left: `${(playhead / ruler) * 100}%` }} />
      </div>
      <div className="timeline-foot">
        <span>{formatTime(playhead)}</span>
        <span>Amber = keyframes · gaps play black · Save joins clips</span>
        <span>{formatTime(timelineDuration(project))}</span>
      </div>
    </div>
  );
}

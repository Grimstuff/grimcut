import { useEffect, useRef, useState } from "react";
import { AR_PRESETS, RES_BY_AR, arOf } from "../core/canvas";
import { useEditor } from "../store/editorStore";
import { applyPreviewVolume, togglePlayback } from "../lib/playbackClock";

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

function lcdTime(t: number) {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const ms = Math.floor((t % 1) * 1000);
  const total = Math.floor(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M4.2 2.4v11.2L13.6 8 4.2 2.4z" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z" />
    </svg>
  );
}
function IconRecord() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" opacity="0.35" />
    </svg>
  );
}
function IconCut() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M3.2 3.2c1.6 1.6 4.2 5.2 4.8 4.8M3.2 12.8c1.6-1.6 4.2-5.2 4.8-4.8M12.8 3.2 8 8l4.8 4.8"
      />
      <circle cx="3.4" cy="3.4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="3.4" cy="12.6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function IconDelete() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 4.5h9M6 4.5V3.2h4v1.3M5.2 4.5l.5 8.2h4.6l.5-8.2"
      />
    </svg>
  );
}
function IconExport() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 9.5V2.8M5.2 5 8 2.5 10.8 5M3.2 9.2v3.6h9.6V9.2"
      />
    </svg>
  );
}
function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M2.8 6.1h2.1L8 3.6v8.8L4.9 9.9H2.8z" />
      {!muted ? (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M10.2 6.1c.8.7.8 3.1 0 3.8M12.1 4.6c1.6 1.5 1.6 5.3 0 6.8"
        />
      ) : (
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M10.4 6.2 13 9.4M13 6.2l-2.6 3.2" />
      )}
    </svg>
  );
}

function parseRes(text: string): { w: number; h: number } | null {
  const m = text.trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 16 || h < 16) return null;
  return { w, h };
}

export function TransportBar() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => s.selectedId);
  const range = useEditor((s) => s.range);
  const busy = useEditor((s) => s.busy);
  const volume = useEditor((s) => s.previewVolume);
  const [arOpen, setArOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [resText, setResText] = useState("");
  const wrap = useRef<HTMLDivElement>(null);
  const lastVol = useRef(1);

  useEffect(() => {
    if (!project) return;
    setResText(`${project.canvasWidth} × ${project.canvasHeight}`);
  }, [project?.canvasWidth, project?.canvasHeight]);

  useEffect(() => {
    applyPreviewVolume(volume);
  }, [volume]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setArOpen(false);
        setResOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!project) return null;

  const ar = arOf(project.canvasWidth, project.canvasHeight);
  const resList = RES_BY_AR[ar] ?? RES_BY_AR["16:9"];
  const rangeDur = range ? Math.abs(range.end - range.start) : 0;
  const selected = project.clips.find((c) => c.id === selectedId);
  const canCut = rangeDur > 0.04;
  const canDel = !!selected || canCut;
  const muted = volume <= 0.001;

  const applyTyped = () => {
    const parsed = parseRes(resText);
    if (parsed) useEditor.getState().setCanvas(parsed.w, parsed.h);
    else setResText(`${project.canvasWidth} × ${project.canvasHeight}`);
  };

  return (
    <div className="tl-bar" ref={wrap}>
      <div className="tl-bar-left">
        <div className={`tb-combo${arOpen ? " is-open" : ""}`}>
          <button
            type="button"
            className="tb-combo-btn"
            title="Aspect ratio"
            onClick={() => {
              setArOpen((v) => !v);
              setResOpen(false);
            }}
          >
            {ar}
            <span className="tb-caret" />
          </button>
          {arOpen ? (
            <div className="tb-menu">
              {AR_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={p.id === ar ? "is-on" : ""}
                  onClick={() => {
                    setArOpen(false);
                    if (p.id !== ar) useEditor.getState().setCanvasPreset(p.id);
                  }}
                >
                  {p.id}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className={`tb-combo tb-res${resOpen ? " is-open" : ""}`}>
          <input
            className="tb-res-input"
            value={resText}
            title="Canvas resolution"
            onFocus={() => {
              setResOpen(true);
              setArOpen(false);
            }}
            onChange={(e) => setResText(e.target.value)}
            onBlur={applyTyped}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                applyTyped();
                setResOpen(false);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          <button
            type="button"
            className="tb-caret-btn"
            title="Common resolutions"
            onClick={() => {
              setResOpen((v) => !v);
              setArOpen(false);
            }}
          >
            <span className="tb-caret" />
          </button>
          {resOpen ? (
            <div className="tb-menu tb-menu-wide">
              {resList.map((r) => (
                <button
                  key={r.label}
                  type="button"
                  className={r.w === project.canvasWidth && r.h === project.canvasHeight ? "is-on" : ""}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    useEditor.getState().setCanvas(r.w, r.h);
                    setResOpen(false);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="tb-vol" title="Preview volume">
          <button
            type="button"
            className="icon-btn"
            title={muted ? "Unmute preview" : "Mute preview"}
            onClick={() => {
              if (muted) {
                const v = lastVol.current || 0.8;
                useEditor.getState().setPreviewVolume(v);
                applyPreviewVolume(v);
              } else {
                lastVol.current = volume;
                useEditor.getState().setPreviewVolume(0);
                applyPreviewVolume(0);
              }
            }}
          >
            <IconSpeaker muted={muted} />
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            aria-label="Preview volume"
            onChange={(e) => {
              const v = Number(e.target.value);
              if (v > 0) lastVol.current = v;
              useEditor.getState().setPreviewVolume(v);
              applyPreviewVolume(v);
            }}
          />
        </div>
      </div>

      <div className="tl-bar-center">
        <div className="lcd" title="Playhead">
          {lcdTime(playhead)}
        </div>
        <button
          type="button"
          className={`icon-btn icon-btn-lg${playing ? " is-on" : ""}`}
          title="Play / pause (Space)"
          onClick={() => togglePlayback()}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button type="button" className="icon-btn icon-btn-lg is-record" title="Record (coming later)" disabled>
          <IconRecord />
        </button>
      </div>

      <div className="tl-bar-right">
        <button
          type="button"
          className="icon-btn"
          title="Cut selected range (Ctrl+X)"
          disabled={!canCut}
          onClick={() => useEditor.getState().liftRange()}
        >
          <IconCut />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="Delete clip or range (Delete)"
          disabled={!canDel}
          onClick={() => useEditor.getState().del()}
        >
          <IconDelete />
        </button>
        <button
          type="button"
          className="icon-btn icon-export"
          title="Export / save (Ctrl+S)"
          disabled={busy}
          onClick={() => void useEditor.getState().exportVideo()}
        >
          <IconExport />
        </button>
      </div>
    </div>
  );
}

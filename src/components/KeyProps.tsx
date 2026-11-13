import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { guessScreenColor } from "../core/chromakey";
import { clipSourcePath } from "../core/project";
import { DEFAULT_KEY, type Clip, type ClipEffect, type KeyParams } from "../core/types";
import { layerVideo } from "../lib/playbackClock";
import { useEditor } from "../store/editorStore";
import { KEY_PICK } from "./Preview";

/** Guess the screen color from the clip's current preview frame. */
export function autoKeyColor(clip: Clip): string | null {
  const el = layerVideo(clip.layer);
  if (!el || el.readyState < 2 || !el.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 54;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(el, 0, 0, 96, 54);
    return guessScreenColor(ctx.getImageData(0, 0, 96, 54).data);
  } catch {
    return null;
  }
}

function Slider({
  label,
  title,
  value,
  min,
  max,
  step,
  fmt,
  onLive,
  onCommit,
}: {
  label: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: (n: number) => string;
  onLive: (n: number) => void;
  onCommit: (before: Clip[] | null) => void;
}) {
  const before = useRef<Clip[] | null>(null);
  return (
    <span className="tb-key-slider" title={title}>
      <span className="tb-prop-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={title}
        onPointerDown={() => {
          before.current = useEditor.getState().snapshot();
        }}
        onChange={(e) => onLive(Number(e.target.value))}
        onPointerUp={() => {
          onCommit(before.current);
          before.current = null;
        }}
        onKeyUp={() => onCommit(useEditor.getState().snapshot())}
      />
      <span className="tb-prop-val">{fmt(value)}</span>
    </span>
  );
}

export function KeyProps({ clip, fx }: { clip: Clip; fx: ClipEffect }) {
  const k: KeyParams = { ...DEFAULT_KEY, ...fx.key };
  const picking = useEditor((s) => s.colorPickId === KEY_PICK + fx.id);
  const [edgeOpen, setEdgeOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const edgeRef = useRef<HTMLDivElement>(null);
  const st = () => useEditor.getState();
  const live = (patch: Partial<KeyParams>) => st().setKeyParams(fx.id, patch);
  const commit = (before: Clip[] | null) => {
    if (before) st().commit(before, "Chroma key");
  };

  useEffect(() => {
    if (!edgeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!edgeRef.current?.contains(e.target as Node)) setEdgeOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [edgeOpen]);

  return (
    <div className="tb-props tb-key">
      <span className="tb-prop-label">Key</span>
      <button
        type="button"
        className={`tb-color-chip${picking ? " is-on" : ""}`}
        style={{ background: k.color }}
        title="Key color — click, then click the screen in the preview"
        onClick={() => st().setColorPick(picking ? null : KEY_PICK + fx.id)}
      />
      <button
        type="button"
        className="tb-key-btn"
        title="Find the screen color automatically"
        onClick={() => {
          const hex = autoKeyColor(clip);
          if (hex) st().setKeyParams(fx.id, { color: hex }, st().snapshot());
          else useEditor.setState({ status: "No green or blue screen found in this frame" });
        }}
      >
        Auto
      </button>
      <Slider
        label="Range"
        title="How close to the key color is removed"
        value={k.similarity}
        min={0.01}
        max={0.4}
        step={0.005}
        fmt={(n) => n.toFixed(2)}
        onLive={(n) => live({ similarity: n })}
        onCommit={commit}
      />
      <Slider
        label="Soft"
        title="Edge softness (blend)"
        value={k.blend}
        min={0}
        max={0.3}
        step={0.005}
        fmt={(n) => n.toFixed(2)}
        onLive={(n) => live({ blend: n })}
        onCommit={commit}
      />
      <Slider
        label="Spill"
        title="Remove screen color bleeding onto the subject"
        value={k.spill}
        min={0}
        max={1}
        step={0.05}
        fmt={(n) => `${Math.round(n * 100)}%`}
        onLive={(n) => live({ spill: n })}
        onCommit={commit}
      />
      <div className="tb-key-edge" ref={edgeRef}>
        <button
          type="button"
          className={`tb-key-btn${edgeOpen ? " is-on" : ""}`}
          title="Choke and feather the matte edge"
          onClick={() => setEdgeOpen((v) => !v)}
        >
          Edge
        </button>
        {edgeOpen ? (
          <div className="tb-float tb-key-pop">
            <Slider
              label="Choke"
              title="Shrink the matte edge (pixels)"
              value={k.choke}
              min={0}
              max={8}
              step={1}
              fmt={(n) => `${n}px`}
              onLive={(n) => live({ choke: n })}
              onCommit={commit}
            />
            <Slider
              label="Feather"
              title="Blur the matte edge (pixels)"
              value={k.feather}
              min={0}
              max={8}
              step={0.5}
              fmt={(n) => `${n}px`}
              onLive={(n) => live({ feather: n })}
              onCommit={commit}
            />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="tb-key-btn is-adv"
        title="Advanced key: CorridorKey AI keyer (installs on first use)"
        onClick={() => setAdvOpen(true)}
      >
        Advanced key…
      </button>
      {advOpen ? <AdvancedKeyDialog clip={clip} k={k} onClose={() => setAdvOpen(false)} /> : null}
    </div>
  );
}

type CkStatus = {
  installed: boolean;
  device: string | null;
  nvidia: boolean;
  gpu: string | null;
  vramMb: number | null;
  dir: string;
  sizeMb: number;
  busy: boolean;
};

type Phase = "checking" | "setup" | "installing" | "ready" | "running" | "error";

function AdvancedKeyDialog({ clip, k, onClose }: { clip: Clip; k: KeyParams; onClose: () => void }) {
  const [status, setStatus] = useState<CkStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [prog, setProg] = useState<{ label: string; pct: number; line: string }>({ label: "", pct: 0, line: "" });
  const [err, setErr] = useState("");
  const [agree, setAgree] = useState(false);
  const [quality, setQuality] = useState<1024 | 2048>(2048);
  const [device, setDevice] = useState<"cuda" | "cpu">("cpu");

  const refresh = async () => {
    const s = await invoke<CkStatus>("ck_status");
    setStatus(s);
    setDevice(s.device === "cuda" || (!s.installed && s.nvidia) ? "cuda" : "cpu");
    setQuality(s.device === "cuda" && (s.vramMb ?? 0) >= 8000 ? 2048 : 1024);
    setPhase(s.busy ? "running" : s.installed ? "ready" : "setup");
  };

  useEffect(() => {
    void refresh().catch((e) => {
      setErr(String(e));
      setPhase("error");
    });
    const un = listen<{ label: string; pct: number; line: string }>("ck-progress", (e) => setProg(e.payload));
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const install = async () => {
    setPhase("installing");
    setErr("");
    try {
      await invoke("ck_install", { device });
      await refresh();
    } catch (e) {
      setErr(String(e));
      setPhase("setup");
    }
  };

  const run = async () => {
    const st = useEditor.getState();
    const p = st.project;
    if (!p) return;
    const path = clipSourcePath(p, clip);
    const m = st.mediaByPath[path] ?? (path === p.sourcePath ? st.media : null);
    if (!m?.width || !m.height) {
      setErr("Couldn't read this clip's size.");
      return;
    }
    setPhase("running");
    setErr("");
    try {
      const out = await invoke<string>("ck_run", {
        job: {
          sourcePath: path,
          sourceStart: clip.sourceStart,
          sourceEnd: clip.sourceEnd,
          frameRate: m.frameRate ?? null,
          width: m.width,
          height: m.height,
          key: k,
          imgSize: quality,
          despill: Math.max(0.5, k.spill),
        },
      });
      await st.applyKeyedSource(clip.id, out);
      onClose();
    } catch (e) {
      const msg = String(e);
      setErr(msg === "Cancelled." ? "" : msg);
      setPhase("ready");
    }
  };

  const uninstall = async () => {
    try {
      await invoke("ck_uninstall");
      await refresh();
    } catch (e) {
      setErr(String(e));
    }
  };

  const busy = phase === "installing" || phase === "running";
  const len = clip.sourceEnd - clip.sourceStart;
  const gpuLine = status
    ? status.nvidia
      ? `${status.gpu ?? "NVIDIA GPU"}${status.vramMb ? ` · ${Math.round(status.vramMb / 1024)} GB` : ""}`
      : `${status.gpu ?? "No NVIDIA GPU found"} · CPU mode`
    : "";

  let body: ReactNode = null;
  let actions: ReactNode = null;
  if (phase === "checking") {
    body = <p className="about-blurb">Checking…</p>;
  } else if (phase === "setup") {
    body = (
      <>
        <p className="about-blurb">
          CorridorKey is Corridor Digital's AI keyer. It refines hair, motion blur and see-through edges far beyond a
          normal chroma key. Grimcut sets it up on first use, in its own folder, and only runs it when you ask.
        </p>
        <ul className="ck-facts">
          <li>
            <b>This PC:</b> {gpuLine}
          </li>
          <li>
            <b>Download:</b>{" "}
            {device === "cuda" ? "about 3 GB (PyTorch with CUDA + 300 MB model)" : "about 600 MB (PyTorch for CPU + 300 MB model)"}
          </li>
          {!status?.nvidia ? (
            <li className="ck-warn">
              Without an NVIDIA GPU it runs on the CPU: expect several seconds per frame or more. Fine for short clips.
            </li>
          ) : (status.vramMb ?? 0) < 6000 ? (
            <li className="ck-warn">CorridorKey wants 6 GB+ of VRAM; use the 1024 quality setting.</li>
          ) : null}
        </ul>
        {status?.nvidia ? (
          <label className="ck-row">
            <input type="checkbox" checked={device === "cpu"} onChange={(e) => setDevice(e.target.checked ? "cpu" : "cuda")} />
            Install the CPU version instead (smaller, much slower)
          </label>
        ) : null}
        <label className="ck-row">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>
            I accept the{" "}
            <button
              type="button"
              className="ck-link"
              onClick={() => void openUrl("https://github.com/nikopueringer/CorridorKey/blob/main/LICENSE").catch(() => {})}
            >
              CorridorKey licence
            </button>{" "}
            (CC BY-NC-SA 4.0 with extra terms: fine for your own projects, commercial footage included; no reselling it or
            running it as a paid service).
          </span>
        </label>
        {err ? <p className="ck-err">{err}</p> : null}
      </>
    );
    actions = (
      <div className="update-actions">
        <button type="button" className="update-later" onClick={onClose}>
          Not now
        </button>
        <button type="button" className="about-ok" disabled={!agree} onClick={() => void install()}>
          Install
        </button>
      </div>
    );
  } else if (phase === "ready" && clip.layer !== "over") {
    body = (
      <p className="about-blurb">
        Put this clip on the 2nd layer (overlay) first: the keyed result plays over whatever is on the main track.
      </p>
    );
    actions = (
      <div className="update-actions">
        <button type="button" className="about-ok" onClick={onClose}>
          OK
        </button>
      </div>
    );
  } else if (phase === "ready") {
    body = (
      <>
        <p className="about-blurb">
          Runs CorridorKey on this clip ({len.toFixed(1)} s), using your current chroma key as its rough guide, then swaps
          the clip for the keyed result. Undo brings the original back.
        </p>
        <ul className="ck-facts">
          <li>
            <b>Running on:</b> {status?.device === "cuda" ? gpuLine : "CPU"}
          </li>
          <li>
            <b>Installed:</b> {status?.sizeMb ?? 0} MB ·{" "}
            <button type="button" className="ck-link" onClick={() => void uninstall()}>
              Remove
            </button>
          </li>
        </ul>
        <label className="ck-row">
          Quality
          <select value={quality} onChange={(e) => setQuality(Number(e.target.value) === 2048 ? 2048 : 1024)}>
            <option value={1024}>Fast (1024)</option>
            <option value={2048}>Best (2048, needs ~10 GB VRAM)</option>
          </select>
        </label>
        <p className="about-meta">Tip: get the normal key close first. CorridorKey cleans up the edges from there.</p>
        {err ? <p className="ck-err">{err}</p> : null}
      </>
    );
    actions = (
      <div className="update-actions">
        <button type="button" className="update-later" onClick={onClose}>
          Close
        </button>
        <button type="button" className="about-ok" onClick={() => void run()}>
          Run
        </button>
      </div>
    );
  } else if (busy) {
    body = (
      <>
        <p className="about-blurb">{prog.label || (phase === "installing" ? "Installing…" : "Keying…")}</p>
        <div className="update-progress" aria-hidden="true">
          <div className="update-progress-bar" style={{ width: `${Math.max(1, Math.min(100, prog.pct))}%` }} />
        </div>
        <p className="about-meta ck-line">{prog.line}</p>
      </>
    );
    actions = (
      <div className="update-actions">
        <button type="button" className="update-later" onClick={() => void invoke("ck_cancel")}>
          Cancel
        </button>
      </div>
    );
  } else {
    body = <p className="ck-err">{err}</p>;
    actions = (
      <div className="update-actions">
        <button type="button" className="about-ok" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  return createPortal(
    <div className="about-overlay" role="presentation" onMouseDown={busy ? undefined : onClose}>
      <div
        className="about-dialog update-dialog ck-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ck-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h1 id="ck-title" className="about-title">
          Advanced key
        </h1>
        {body}
        {actions}
      </div>
    </div>,
    document.body,
  );
}

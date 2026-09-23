import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { AppChrome } from "./components/AppChrome";
import { Preview } from "./components/Preview";
import { dropClientX, Timeline, timelineTimeAt } from "./components/Timeline";
import { BusyOverlay } from "./components/BusyOverlay";
import { useEditor } from "./store/editorStore";
import { pushAspectLock } from "./lib/fitWindow";
import { startPlaybackClock } from "./lib/playbackClock";
import { startHotkeys } from "./lib/hotkeys";
import { initSystemAccent } from "./lib/systemAccent";
import { startAgentBridge } from "./agent/bridge";

export default function App() {
  const status = useEditor((s) => s.status);
  const bgJobs = useEditor((s) => s.bgJobs);
  const setProgress = useEditor((s) => s.setProgress);
  const mediaW = useEditor((s) => s.project?.canvasWidth ?? s.media?.width ?? 0);
  const mediaH = useEditor((s) => s.project?.canvasHeight ?? s.media?.height ?? 0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    let unlistenDrop: (() => void) | undefined;
    let unlistenProg: (() => void) | undefined;
    (async () => {
      try {
        const webview = getCurrentWebview();
        let hoverPath = "";
        unlistenDrop = await webview.onDragDropEvent((event) => {
          const st = useEditor.getState();
          if (event.payload.type === "leave") {
            hoverPath = "";
            st.clearDropGhost();
            return;
          }
          const x = dropClientX(event.payload.position.x);
          const t = timelineTimeAt(x);
          if (event.payload.type === "enter") {
            hoverPath = event.payload.paths[0] ?? "";
            if (!st.project) return;
            if (hoverPath) st.hoverDrop(hoverPath, t);
            return;
          }
          if (event.payload.type === "over") {
            if (!st.project || !hoverPath) return;
            st.hoverDrop(hoverPath, t);
            return;
          }
          if (event.payload.type === "drop") {
            const p = event.payload.paths[0] ?? hoverPath;
            hoverPath = "";
            if (p) void st.dropFile(p, t);
          }
        });
      } catch {
        /* browser preview */
      }
      try {
        unlistenProg = await listen<string | { label?: string; pct?: number }>("export-progress", (e) => {
          const p = e.payload;
          if (typeof p === "string") {
            const prev = useEditor.getState().progress;
            setProgress({ label: p || "Working…", pct: Math.min(92, (prev?.pct ?? 15) + 8) });
            return;
          }
          if (p && typeof p === "object") {
            setProgress({
              label: p.label || useEditor.getState().progress?.label || "Working…",
              pct: typeof p.pct === "number" ? p.pct : useEditor.getState().progress?.pct ?? 8,
            });
          }
        });
      } catch {
        /* not in tauri */
      }
    })();
    return () => {
      unlistenDrop?.();
      unlistenProg?.();
    };
  }, [setProgress]);

  useEffect(() => startPlaybackClock(), []);
  useEffect(() => {
    void invoke<string>("ensure_ffmpeg_cmd")
      .then(() => {
        const p = useEditor.getState().progress;
        if (p?.label?.includes("FFmpeg")) useEditor.getState().setProgress(null);
      })
      .catch((e) => useEditor.setState({ status: String(e) }));
  }, []);
  useEffect(() => startAgentBridge(), []);
  useEffect(() => {
    startHotkeys();
  }, []);
  useEffect(() => initSystemAccent(), []);

  useEffect(() => {
    const aspect = mediaW && mediaH ? mediaW / mediaH : null;
    void pushAspectLock(aspect);
    if (!aspect) return;
    const ro = new ResizeObserver(() => {
      void pushAspectLock(aspect);
    });
    const tl = document.querySelector(".timeline");
    const ch = document.querySelector(".chrome");
    if (tl) ro.observe(tl);
    if (ch) ro.observe(ch);
    return () => {
      ro.disconnect();
      void pushAspectLock(null);
    };
  }, [mediaW, mediaH]);

  return (
    <div className="app" tabIndex={-1}>
      <AppChrome />
      <div className="workspace">
        <Timeline />
        <Preview />
      </div>
      <footer className="status">
        <span
          className="status-msg"
          title="Select to copy"
          onDoubleClick={(e) => {
            const el = e.currentTarget;
            const r = document.createRange();
            r.selectNodeContents(el);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(r);
          }}
        >
          {status}
        </span>
        {Object.keys(bgJobs).length > 0 ? (
          <span className="status-jobs">
            <span className="status-spin" aria-hidden />
            Generating {Object.values(bgJobs).join(" · ")}
          </span>
        ) : null}
      </footer>
      <BusyOverlay />
    </div>
  );
}

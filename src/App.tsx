import { useEffect } from "react";
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

export default function App() {
  const status = useEditor((s) => s.status);
  const setProgress = useEditor((s) => s.setProgress);
  const mediaW = useEditor((s) => s.media?.width ?? 0);
  const mediaH = useEditor((s) => s.media?.height ?? 0);

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
        unlistenProg = await listen<string>("export-progress", (e) => {
          const label = e.payload || "Working…";
          const prev = useEditor.getState().progress;
          const pct = Math.min(92, (prev?.pct ?? 15) + 8);
          setProgress({ label, pct });
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
    startHotkeys();
  }, []);

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
      <footer className="status">{status}</footer>
      <BusyOverlay />
    </div>
  );
}

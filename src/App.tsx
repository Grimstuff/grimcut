import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { AppChrome } from "./components/AppChrome";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { BusyOverlay } from "./components/BusyOverlay";
import { useEditor } from "./store/editorStore";
import { pushAspectLock } from "./lib/fitWindow";
import { applyLiveResizeScale, beginLiveResize, endLiveResize } from "./lib/liveResize";

export default function App() {
  const status = useEditor((s) => s.status);
  const openPath = useEditor((s) => s.openPath);
  const setProgress = useEditor((s) => s.setProgress);
  const mediaW = useEditor((s) => s.media?.width ?? 0);
  const mediaH = useEditor((s) => s.media?.height ?? 0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    let unlistenDrop: (() => void) | undefined;
    let unlistenProg: (() => void) | undefined;
    let unlistenResize: (() => void) | undefined;
    (async () => {
      try {
        const webview = getCurrentWebview();
        unlistenDrop = await webview.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const p = event.payload.paths[0];
            if (p) void openPath(p);
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
      try {
        const a = await listen("win-resize-start", () => beginLiveResize());
        const b = await listen("win-resize-end", () => endLiveResize());
        const onWin = () => applyLiveResizeScale();
        window.addEventListener("resize", onWin);
        unlistenResize = () => {
          a();
          b();
          window.removeEventListener("resize", onWin);
          endLiveResize();
        };
      } catch {
        /* not in tauri */
      }
    })();
    return () => {
      unlistenDrop?.();
      unlistenProg?.();
      unlistenResize?.();
    };
  }, [openPath, setProgress]);

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
    <div className="app">
      <AppChrome />
      <div className="workspace">
        <Preview />
        <Timeline />
      </div>
      <footer className="status">{status}</footer>
      <BusyOverlay />
    </div>
  );
}

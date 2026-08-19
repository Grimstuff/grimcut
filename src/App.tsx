import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { AppChrome } from "./components/AppChrome";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { BusyOverlay } from "./components/BusyOverlay";
import { useEditor } from "./store/editorStore";

export default function App() {
  const status = useEditor((s) => s.status);
  const openPath = useEditor((s) => s.openPath);
  const setProgress = useEditor((s) => s.setProgress);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    let unlistenDrop: (() => void) | undefined;
    let unlistenProg: (() => void) | undefined;
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
    })();
    return () => {
      unlistenDrop?.();
      unlistenProg?.();
    };
  }, [openPath, setProgress]);

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

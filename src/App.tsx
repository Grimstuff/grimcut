import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { AppChrome } from "./components/AppChrome";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { useEditor } from "./store/editorStore";

export default function App() {
  const status = useEditor((s) => s.status);
  const openPath = useEditor((s) => s.openPath);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", "dark");
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          if (event.payload.type === "drop") {
            const p = event.payload.paths[0];
            if (p) void openPath(p);
          }
        });
      } catch {
        /* browser preview */
      }
    })();
    return () => unlisten?.();
  }, [openPath]);

  return (
    <div className="app">
      <AppChrome />
      <div className="workspace">
        <Preview />
        <Timeline />
      </div>
      <footer className="status">{status}</footer>
    </div>
  );
}

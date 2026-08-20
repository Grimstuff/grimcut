import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { AppChrome } from "./components/AppChrome";
import { Preview } from "./components/Preview";
import { Timeline } from "./components/Timeline";
import { BusyOverlay } from "./components/BusyOverlay";
import { useEditor } from "./store/editorStore";
import { pushAspectLock } from "./lib/fitWindow";
import { startPlaybackClock, togglePlayback } from "./lib/playbackClock";

const KEYS = "__grimcutKeys";
type KeysWin = Window & { [KEYS]?: (e: KeyboardEvent) => void };

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

  useEffect(() => startPlaybackClock(), []);

  useEffect(() => {
    const w = window as KeysWin;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const st = useEditor.getState();
      if (st.menuOpen) return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (e.repeat) return;
        if (t && t.tagName === "BUTTON") t.blur();
        togglePlayback();
        return;
      }
      if (e.ctrlKey && e.code === "KeyO") {
        e.preventDefault();
        void st.pickOpen();
      }
      if (e.ctrlKey && e.code === "KeyS") {
        e.preventDefault();
        void st.exportVideo();
      }
      if (e.code === "KeyS" && !e.ctrlKey) {
        e.preventDefault();
        st.slice();
      }
      if (e.ctrlKey && e.code === "KeyC") {
        e.preventDefault();
        st.copyRange();
      }
      if (e.ctrlKey && e.code === "KeyV") {
        e.preventDefault();
        st.paste(e.shiftKey ? "audio" : undefined);
      }
      if (e.ctrlKey && e.code === "KeyX") {
        e.preventDefault();
        st.liftRange();
      }
      if (e.ctrlKey && e.code === "KeyZ") {
        e.preventDefault();
        st.undo();
      }
      if (e.ctrlKey && e.code === "KeyY") {
        e.preventDefault();
        st.redo();
      }
      if (e.code === "Delete" || e.code === "Backspace") {
        e.preventDefault();
        st.del();
      }
    };
    if (w[KEYS]) window.removeEventListener("keydown", w[KEYS], true);
    w[KEYS] = onKey;
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (w[KEYS] === onKey) w[KEYS] = undefined;
    };
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
    <div className="app">
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

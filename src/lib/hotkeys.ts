import { useEditor } from "../store/editorStore";
import { noteUserSeek, syncPreviewToPlayhead, togglePlayback } from "./playbackClock";

const KEYS = "__grimcutKeys";
type KeysWin = Window & { [KEYS]?: (e: KeyboardEvent) => void };

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  const st = useEditor.getState();
  if (st.colorPickId) {
    if (e.code === "Escape") {
      e.preventDefault();
      st.setColorPick(null);
    }
    return;
  }
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
    st.cutOrSlice();
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
  if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
    e.preventDefault();
    if (st.playing) st.setPlaying(false);
    const fps = st.media?.frameRate;
    const dt = 1 / (fps && fps > 1 && fps < 240 ? fps : 30);
    st.setPlayhead(st.playhead + (e.code === "ArrowRight" ? dt : -dt));
    noteUserSeek();
    syncPreviewToPlayhead();
  }
}

export function startHotkeys() {
  const w = window as KeysWin;
  if (w[KEYS]) window.removeEventListener("keydown", w[KEYS], true);
  w[KEYS] = onKey;
  window.addEventListener("keydown", onKey, true);
}

export function focusApp() {
  try {
    window.focus();
  } catch {
    /* ignore */
  }
  const app = document.querySelector(".app") as HTMLElement | null;
  app?.focus({ preventScroll: true });
}

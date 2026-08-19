import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEditor } from "../store/editorStore";

async function winAction(kind: "minimize" | "toggleMaximize" | "close") {
  try {
    const w = getCurrentWindow();
    if (kind === "minimize") await w.minimize();
    else if (kind === "toggleMaximize") {
      if (await w.isMaximized()) await w.unmaximize();
      else await w.maximize();
    } else await w.close();
  } catch {
    /* browser */
  }
}

export function AppChrome() {
  const menuOpen = useEditor((s) => s.menuOpen);
  const setMenuOpen = useEditor((s) => s.setMenuOpen);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 });
  const [maximized, setMaximized] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const has = useEditor((s) => s.project != null);
  const busy = useEditor((s) => s.busy);
  const pickOpen = useEditor((s) => s.pickOpen);
  const closeProject = useEditor((s) => s.closeProject);
  const slice = useEditor((s) => s.slice);
  const del = useEditor((s) => s.del);
  const copyRange = useEditor((s) => s.copyRange);
  const paste = useEditor((s) => s.paste);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const exportVideo = useEditor((s) => s.exportVideo);
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const undoLabel = useEditor((s) => s.undoLabel);
  const redoLabel = useEditor((s) => s.redoLabel);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const win = getCurrentWindow();
        setMaximized(await win.isMaximized());
        unlisten = await win.onResized(async () => setMaximized(await win.isMaximized()));
      } catch {
        /* browser */
      }
    })();
    return () => unlisten?.();
  }, []);

  useLayoutEffect(() => {
    if (!menuOpen || !hamburgerRef.current) return;
    const rect = hamburgerRef.current.getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 2, left: rect.left });
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: PointerEvent) => {
      const n = e.target as Node | null;
      if (!n) return;
      if (hamburgerRef.current?.contains(n)) return;
      if (menuRef.current?.contains(n)) return;
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
        return;
      }
      // Don't play/slice/save while the menu is open — dismiss only.
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [menuOpen, setMenuOpen]);

  const menu = menuOpen
    ? createPortal(
        <div
          ref={menuRef}
          className="menu-dropdown"
          style={{ top: menuPos.top, left: menuPos.left }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="menu-label">File</div>
          <button type="button" className="menu-option" onClick={() => { setMenuOpen(false); void pickOpen(); }}>
            Open… <span className="menu-shortcut">Ctrl+O</span>
          </button>
          <button type="button" className="menu-option" disabled={!has || busy} onClick={() => { setMenuOpen(false); void exportVideo(); }}>
            Save edited video… <span className="menu-shortcut">Ctrl+S</span>
          </button>
          <button type="button" className="menu-option" disabled={!has} onClick={() => { setMenuOpen(false); closeProject(); }}>
            Close
          </button>
          <div className="menu-sep" />
          <div className="menu-label">Edit</div>
          <button type="button" className="menu-option" disabled={!has} onClick={() => { setMenuOpen(false); slice(); }}>
            Slice at playhead <span className="menu-shortcut">S</span>
          </button>
          <button type="button" className="menu-option" disabled={!has} onClick={() => { setMenuOpen(false); del(); }}>
            Delete clip <span className="menu-shortcut">Del</span>
          </button>
          <button type="button" className="menu-option" disabled={!has} onClick={() => { setMenuOpen(false); copyRange(); }}>
            Copy range <span className="menu-shortcut">Ctrl+C</span>
          </button>
          <button type="button" className="menu-option" disabled={!has} onClick={() => { setMenuOpen(false); paste(); }}>
            Paste <span className="menu-shortcut">Ctrl+V</span>
          </button>
          <button type="button" className="menu-option" disabled={!canUndo} onClick={() => { setMenuOpen(false); undo(); }}>
            {undoLabel} <span className="menu-shortcut">Ctrl+Z</span>
          </button>
          <button type="button" className="menu-option" disabled={!canRedo} onClick={() => { setMenuOpen(false); redo(); }}>
            {redoLabel} <span className="menu-shortcut">Ctrl+Y</span>
          </button>
          <div className="menu-sep" />
          <button type="button" className="menu-option" onClick={() => { setMenuOpen(false); void winAction("close"); }}>
            Exit
          </button>
        </div>,
        document.body,
      )
    : null;

  return (
    <header className="chrome">
      <button
        ref={hamburgerRef}
        type="button"
        className="chrome-hamburger"
        aria-expanded={menuOpen}
        title="Menu"
        onClick={() => setMenuOpen(!menuOpen)}
      >
        <span className="chrome-hamburger-icon" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </button>
      <div className="chrome-title">Grimcut</div>
      <div className="chrome-drag" data-tauri-drag-region onDoubleClick={() => void winAction("toggleMaximize")} />
      <div className="chrome-controls">
        <button type="button" className="win-btn" title="Minimize" onClick={() => void winAction("minimize")}>
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M1.5 6h9" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </svg>
        </button>
        <button type="button" className="win-btn" title={maximized ? "Restore" : "Maximize"} onClick={() => void winAction("toggleMaximize")}>
          {maximized ? (
            <svg viewBox="0 0 12 12" aria-hidden>
              <path d="M3 4h6v6H3zM4 3h6v1M10 3v6h-1" stroke="currentColor" strokeWidth="1.4" fill="none" />
            </svg>
          ) : (
            <svg viewBox="0 0 12 12" aria-hidden>
              <rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          )}
        </button>
        <button type="button" className="win-btn win-btn-close" title="Close" onClick={() => void winAction("close")}>
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {menu}
    </header>
  );
}

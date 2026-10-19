import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import appIcon from "../assets/app-icon.png";

const FALLBACK_VERSION = "0.1";

function displayVersion(v: string): string {
  return v.replace(/\.0$/, "");
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const [version, setVersion] = useState(FALLBACK_VERSION);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        const v = await getVersion();
        if (!cancelled && v) setVersion(displayVersion(v));
      } catch {
        /* browser */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(() => closeRef.current?.focus());
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="about-overlay" role="presentation" onMouseDown={onClose}>
      <div
        className="about-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <img className="about-icon" src={appIcon} alt="" width={72} height={72} draggable={false} />
        <h1 id="about-title" className="about-title">
          Grimcut
        </h1>
        <p className="about-version">Version {version}</p>
        <p className="about-blurb">A simple local video editor. Cut, overlay, export.</p>
        <p className="about-meta">Built with Tauri, React, and FFmpeg.</p>
        <button ref={closeRef} type="button" className="about-ok" onClick={onClose}>
          OK
        </button>
      </div>
    </div>,
    document.body,
  );
}

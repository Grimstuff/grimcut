import { useEffect, useRef } from "react";
import { mapTimelineToSource, timelineDuration } from "../core/project";
import { useEditor } from "../store/editorStore";

export function Preview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewUrl = useEditor((s) => s.previewUrl);
  const showBlack = useEditor((s) => s.showBlack);
  const pickOpen = useEditor((s) => s.pickOpen);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  const lastWall = useRef(0);
  const lastClipId = useRef<string | null>(null);
  const fileSeeking = useRef(false);

  useEffect(() => {
    let id = 0;
    const tick = (now: number) => {
      id = requestAnimationFrame(tick);
      const st = useEditor.getState();
      if (!st.playing) {
        lastWall.current = 0;
        return;
      }
      const p = st.project;
      const v = videoRef.current;
      if (!p) {
        st.setPlaying(false);
        return;
      }

      const dt = lastWall.current ? Math.min(0.08, (now - lastWall.current) / 1000) : 0;
      lastWall.current = now;
      const end = Math.max(timelineDuration(p), 0.01);
      const ph = Math.min(end, st.playhead + dt);

      if (ph >= end - 0.0005) {
        useEditor.setState({ playhead: end, showBlack: true, playing: false });
        lastWall.current = 0;
        if (v && !v.paused) void v.pause();
        return;
      }

      const mapped = mapTimelineToSource(p, ph);
      if (!mapped) {
        lastClipId.current = null;
        useEditor.setState({ playhead: ph, showBlack: true });
        if (v && !v.paused) void v.pause();
        return;
      }

      useEditor.setState({ playhead: ph, showBlack: false, selectedId: mapped.clip.id });
      if (!v) return;

      const changed = lastClipId.current !== mapped.clip.id;
      lastClipId.current = mapped.clip.id;
      if (changed) {
        fileSeeking.current = true;
        try {
          v.currentTime = Math.max(0, mapped.source);
        } catch {
          /* ignore */
        }
        void v.play().catch(() => {});
        return;
      }
      if (!fileSeeking.current && Math.abs(v.currentTime - mapped.source) > 0.4) {
        fileSeeking.current = true;
        try {
          v.currentTime = Math.max(0, mapped.source);
        } catch {
          /* ignore */
        }
      }
      if (v.paused && !fileSeeking.current) void v.play().catch(() => {});
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [previewUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const clear = () => {
      fileSeeking.current = false;
    };
    v.addEventListener("seeked", clear);
    v.addEventListener("playing", clear);
    return () => {
      v.removeEventListener("seeked", clear);
      v.removeEventListener("playing", clear);
    };
  }, [previewUrl]);

  const togglePlay = () => {
    const st = useEditor.getState();
    if (st.menuOpen) {
      st.setMenuOpen(false);
      return;
    }
    if (!st.project) return;
    if (st.playing) {
      st.setPlaying(false);
      const v = videoRef.current;
      if (v && !v.paused) void v.pause();
      return;
    }
    lastWall.current = 0;
    lastClipId.current = null;
    st.setPlaying(true);
    const mapped = mapTimelineToSource(st.project, st.playhead);
    const v = videoRef.current;
    if (v && mapped) {
      try {
        v.currentTime = mapped.source;
      } catch {
        /* ignore */
      }
      void v.play().catch(() => {});
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const st = useEditor.getState();
      if (st.menuOpen) return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        togglePlay();
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
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  if (!previewUrl) {
    return (
      <div className="preview-wrap">
        <div className="drop-hint">
          <h1>Grimcut</h1>
          <p>Drop a video here or Open…</p>
          <p style={{ fontSize: 12, opacity: 0.7 }}>Simple cuts. Save. No encode maze.</p>
          <button type="button" className="menu-option" style={{ margin: "16px auto", width: "auto" }} onClick={() => void pickOpen()}>
            Open video…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="preview-wrap" onClick={togglePlay} title="Click or Space to play/pause">
      <video
        ref={videoRef}
        src={previewUrl}
        onLoadedMetadata={() => {
          const v = videoRef.current;
          if (!v) return;
          const src = setPlayhead(0);
          if (src != null) v.currentTime = src;
        }}
      />
      {showBlack ? <div className="black-gap">Gap</div> : null}
    </div>
  );
}

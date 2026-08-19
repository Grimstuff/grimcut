import { useEffect, useRef } from "react";
import { clipAt, mapTimelineToSource, timelineDuration } from "../core/project";
import { useEditor } from "../store/editorStore";

/**
 * Timeline clock owns the pin. The <video> is only the head reading the file
 * under that pin — we never map decoder time back onto clips (that caused gap loops).
 */
export function Preview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewUrl = useEditor((s) => s.previewUrl);
  const showBlack = useEditor((s) => s.showBlack);
  const pickOpen = useEditor((s) => s.pickOpen);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  const playing = useRef(false);
  const lastWall = useRef(0);
  const lastClipId = useRef<string | null>(null);
  const fileSeeking = useRef(false);
  const raf = useRef(0);

  const stopTransport = () => {
    playing.current = false;
    lastWall.current = 0;
    const v = videoRef.current;
    if (v && !v.paused) void v.pause();
  };

  const cueFile = (source: number, play: boolean) => {
    const v = videoRef.current;
    if (!v) return;
    fileSeeking.current = true;
    v.currentTime = Math.max(0, source);
    if (play) void v.play();
    else void v.pause();
  };

  const tick = (now: number) => {
    raf.current = requestAnimationFrame(tick);
    if (!playing.current) {
      lastWall.current = 0;
      return;
    }
    const dt = lastWall.current ? Math.min(0.08, (now - lastWall.current) / 1000) : 0;
    lastWall.current = now;

    const st = useEditor.getState();
    const p = st.project;
    if (!p) {
      stopTransport();
      return;
    }
    const end = timelineDuration(p);
    const ph = Math.min(end, st.playhead + dt);
    const mapped = mapTimelineToSource(p, ph);
    const clip = mapped?.clip ?? clipAt(p, ph, "video");

    if (ph >= end - 0.001) {
      useEditor.setState({ playhead: end, showBlack: true });
      stopTransport();
      return;
    }

    if (!mapped || !clip) {
      lastClipId.current = null;
      useEditor.setState({ playhead: ph, showBlack: true });
      const v = videoRef.current;
      if (v && !v.paused) void v.pause();
      return;
    }

    useEditor.setState({ playhead: ph, showBlack: false, selectedId: clip.id });
    const src = mapped.source;
    const v = videoRef.current;
    if (!v) return;

    const clipChanged = lastClipId.current !== clip.id;
    lastClipId.current = clip.id;
    if (clipChanged) {
      cueFile(src, true);
      return;
    }
    if (!fileSeeking.current && Math.abs(v.currentTime - src) > 0.35) {
      cueFile(src, true);
    }
    if (v.paused && !fileSeeking.current) void v.play();
  };

  useEffect(() => {
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [previewUrl]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onSeeked = () => {
      fileSeeking.current = false;
    };
    v.addEventListener("seeked", onSeeked);
    return () => v.removeEventListener("seeked", onSeeked);
  }, [previewUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const st = useEditor.getState();
      if (e.code === "Space") {
        e.preventDefault();
        if (!st.project) return;
        if (playing.current) {
          stopTransport();
          return;
        }
        playing.current = true;
        lastWall.current = 0;
        lastClipId.current = null;
        const mapped = mapTimelineToSource(st.project, st.playhead);
        if (mapped) cueFile(mapped.source, true);
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
        st.slice();
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
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
    <div className="preview-wrap">
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

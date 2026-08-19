import { useEffect, useRef } from "react";
import { gapFromPlayhead, useEditor } from "../store/editorStore";

export function Preview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const gapTimer = useRef<number | null>(null);
  const previewUrl = useEditor((s) => s.previewUrl);
  const showBlack = useEditor((s) => s.showBlack);
  const reportSource = useEditor((s) => s.reportSource);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const pickOpen = useEditor((s) => s.pickOpen);

  const inGap = useRef(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !previewUrl) return;

    let raf = 0;
    let lastJump = -1;
    let ignorePause = false;

    const apply = (playing: boolean) => {
      if (inGap.current) return;
      const r = reportSource(v.currentTime, playing);
      if (r.seek != null && Math.abs(r.seek - lastJump) > 0.02) {
        lastJump = r.seek;
        v.currentTime = r.seek;
      }
      if (r.gap && !inGap.current) {
        ignorePause = true;
        void v.pause();
        startGap(r.gap);
      }
      if (r.stop) {
        ignorePause = true;
        void v.pause();
      }
    };

    const loop = () => {
      if (!inGap.current && !v.paused && !v.ended) apply(true);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onPlay = () => {
      inGap.current = false;
    };
    const onPause = () => {
      if (ignorePause) {
        ignorePause = false;
        return;
      }
      if (!inGap.current) apply(false);
    };
    const onSeeked = () => {
      if (!inGap.current) apply(!v.paused);
    };

    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    return () => {
      cancelAnimationFrame(raf);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
    };
  }, [previewUrl, reportSource]);

  function startGap(gap: { end: number; source: number; id: string }) {
    if (inGap.current) return;
    inGap.current = true;
    if (gapTimer.current) window.clearInterval(gapTimer.current);
    const t0 = performance.now();
    const start = Math.min(useEditor.getState().playhead, gap.end);
    useEditor.setState({ playhead: start, showBlack: true, selectedId: gap.id });
    gapTimer.current = window.setInterval(() => {
      const now = start + (performance.now() - t0) / 1000;
      if (now >= gap.end) {
        if (gapTimer.current) window.clearInterval(gapTimer.current);
        gapTimer.current = null;
        useEditor.setState({ playhead: gap.end, selectedId: gap.id, showBlack: false });
        const v = videoRef.current;
        if (v) {
          v.currentTime = gap.source;
          let done = false;
          const go = () => {
            if (done) return;
            done = true;
            v.removeEventListener("seeked", go);
            inGap.current = false;
            void v.play();
          };
          v.addEventListener("seeked", go);
          window.setTimeout(go, 120);
        } else {
          inGap.current = false;
        }
        return;
      }
      useEditor.setState({ playhead: now, showBlack: true });
    }, 16);
  }

  useEffect(() => {
    return () => {
      if (gapTimer.current) window.clearInterval(gapTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const st = useEditor.getState();
      if (e.code === "Space") {
        e.preventDefault();
        const v = videoRef.current;
        if (!v && !st.project) return;
        if (gapTimer.current) {
          window.clearInterval(gapTimer.current);
          gapTimer.current = null;
          inGap.current = false;
          return;
        }
        if (v) {
          if (!v.paused) {
            void v.pause();
            return;
          }
          const g = gapFromPlayhead();
          if (g) {
            startGap(g);
            return;
          }
          void v.play();
        }
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

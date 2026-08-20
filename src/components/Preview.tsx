import { useEffect, useRef } from "react";
import { mapTimelineToSource } from "../core/project";
import { useEditor } from "../store/editorStore";
import { markVideoSeekDone, resetPlaybackClock, setPreviewVideo } from "../lib/playbackClock";

export function Preview() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const previewUrl = useEditor((s) => s.previewUrl);
  const showBlack = useEditor((s) => s.showBlack);
  const pickOpen = useEditor((s) => s.pickOpen);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  useEffect(() => {
    const v = videoRef.current;
    setPreviewVideo(v ?? null);
    if (!v) return;
    const clear = () => markVideoSeekDone();
    v.addEventListener("seeked", clear);
    v.addEventListener("playing", clear);
    return () => {
      v.removeEventListener("seeked", clear);
      v.removeEventListener("playing", clear);
      setPreviewVideo(null);
    };
  }, [previewUrl]);

  const onPreviewClick = () => {
    const st = useEditor.getState();
    if (st.playing) {
      st.setPlaying(false);
      videoRef.current?.pause();
      return;
    }
    resetPlaybackClock();
    const mapped = st.project ? mapTimelineToSource(st.project, st.playhead) : null;
    const v = videoRef.current;
    if (v && mapped) {
      try {
        v.currentTime = mapped.source;
      } catch {
        /* ignore */
      }
    }
    st.togglePlay();
  };

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
    <div className="preview-wrap" onClick={onPreviewClick} title="Click or Space to play/pause">
      <video
        ref={videoRef}
        src={previewUrl}
        tabIndex={-1}
        playsInline
        disablePictureInPicture
        onMouseDown={(e) => e.preventDefault()}
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

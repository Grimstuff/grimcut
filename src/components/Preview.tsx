import { useEffect, useRef } from "react";
import { useEditor } from "../store/editorStore";
import { markVideoSeekDone, setPreviewVideo, togglePlayback } from "../lib/playbackClock";

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
    v.addEventListener("canplay", clear);
    return () => {
      v.removeEventListener("seeked", clear);
      v.removeEventListener("playing", clear);
      v.removeEventListener("canplay", clear);
    };
  }, [previewUrl]);

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
    <div className="preview-wrap" onClick={() => togglePlayback()} title="Click or Space to play/pause">
      <video
        ref={(el) => {
          videoRef.current = el;
          setPreviewVideo(el);
        }}
        src={previewUrl}
        tabIndex={-1}
        playsInline
        preload="auto"
        disablePictureInPicture
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

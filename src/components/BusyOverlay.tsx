import { useEditor } from "../store/editorStore";

export function BusyOverlay() {
  const progress = useEditor((s) => s.progress);
  if (!progress) return null;
  const pct = Math.max(0, Math.min(100, progress.pct));
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card">
        <div className="busy-label">{progress.label}</div>
        <div className="busy-track">
          <div className="busy-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="busy-row">
          <div className="busy-pct">{Math.round(pct)}%</div>
          <button type="button" className="busy-cancel" onClick={() => useEditor.getState().cancelWork()}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

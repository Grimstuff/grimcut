/** Freeze DOM layout during a native resize; scale with CSS so UI doesn't reflow/vibrate. */

let frozen = false;
let baseW = 1;
let baseH = 1;

function root(): HTMLElement | null {
  return document.getElementById("root");
}

export function beginLiveResize() {
  const el = root();
  if (!el || frozen) return;
  frozen = true;
  baseW = Math.max(1, el.clientWidth);
  baseH = Math.max(1, el.clientHeight);
  el.style.width = `${baseW}px`;
  el.style.height = `${baseH}px`;
  el.style.transformOrigin = "0 0";
  el.style.willChange = "transform";
  document.documentElement.classList.add("is-live-resize");
  applyLiveResizeScale();
}

export function applyLiveResizeScale() {
  if (!frozen) return;
  const el = root();
  if (!el) return;
  const sx = window.innerWidth / baseW;
  const sy = window.innerHeight / baseH;
  el.style.transform = `scale(${sx}, ${sy})`;
}

export function endLiveResize() {
  const el = root();
  frozen = false;
  if (el) {
    el.style.width = "";
    el.style.height = "";
    el.style.transform = "";
    el.style.willChange = "";
  }
  document.documentElement.classList.remove("is-live-resize");
}

import { invoke } from "@tauri-apps/api/core";

const buf: string[] = [];
let flushTimer = 0;

function stamp() {
  const d = new Date();
  return d.toISOString().slice(11, 23);
}

export function playLog(msg: string) {
  buf.push(`${stamp()} ${msg}`);
  if (buf.length > 400) buf.splice(0, buf.length - 300);
  if (!flushTimer) flushTimer = window.setTimeout(flushPlayLog, 800);
}

export function flushPlayLog() {
  flushTimer = 0;
  if (!buf.length) return;
  const line = buf.join("\n");
  buf.length = 0;
  void invoke("append_play_log", { line }).catch(() => {});
}

export function hookMediaLog(el: HTMLMediaElement, tag: string) {
  if (el.dataset.logHook === "1") return;
  el.dataset.logHook = "1";
  const dump = (ev: string) => {
    const err = (el as HTMLVideoElement).error;
    playLog(
      `${tag} ${ev} t=${el.currentTime.toFixed(2)} rs=${el.readyState} paused=${el.paused ? 1 : 0} seeking=${el.seeking ? 1 : 0} net=${el.networkState} err=${err ? `${err.code}:${err.message}` : "-"}`,
    );
  };
  for (const ev of ["error", "waiting", "stalled"]) {
    el.addEventListener(ev, () => dump(ev));
  }
}

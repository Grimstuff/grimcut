/** Isolated audio: hook MediaElementSource only after src is set; never change src on a hooked element. */

type Chan = {
  el: HTMLAudioElement;
  gain: GainNode | null;
  hooked: boolean;
  path: string;
};

let ctx: AudioContext | null = null;
let base: Chan | null = null;
let over: Chan | null = null;

function makeEl(): HTMLAudioElement {
  const el = document.createElement("audio");
  el.preload = "auto";
  el.setAttribute("playsinline", "true");
  el.crossOrigin = "anonymous";
  el.style.cssText = "position:fixed;left:0;top:0;width:8px;height:8px;opacity:0.02;pointer-events:none;z-index:-1";
  document.body.appendChild(el);
  return el;
}

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function chan(which: "base" | "over"): Chan {
  if (which === "base") {
    if (!base) base = { el: makeEl(), gain: null, hooked: false, path: "" };
    return base;
  }
  if (!over) over = { el: makeEl(), gain: null, hooked: false, path: "" };
  return over;
}

function hook(c: Chan) {
  if (c.hooked) return;
  if (!c.el.getAttribute("src")) return;
  const ac = getCtx();
  const src = ac.createMediaElementSource(c.el);
  const g = ac.createGain();
  g.gain.value = 1;
  src.connect(g);
  g.connect(ac.destination);
  c.gain = g;
  c.hooked = true;
}

function disposeEl(el: HTMLAudioElement) {
  el.pause();
  el.removeAttribute("src");
  try {
    el.load();
  } catch {
    /* ignore */
  }
  el.remove();
}

function rebuild(c: Chan) {
  disposeEl(c.el);
  c.el = makeEl();
  c.gain = null;
  c.hooked = false;
  c.path = "";
}

export function soundStop() {
  for (const c of [base, over]) {
    if (!c) continue;
    c.el.pause();
    if (c.gain) c.gain.gain.value = 0;
  }
}

/** Drop hooked elements and the graph so closed media is not still decoded. */
export function soundUnload() {
  for (const c of [base, over]) {
    if (!c) continue;
    if (c.gain) {
      try {
        c.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    disposeEl(c.el);
  }
  base = null;
  over = null;
  if (ctx) {
    const ac = ctx;
    ctx = null;
    void ac.close().catch(() => {});
  }
}

export function soundPrime(): Promise<void> {
  const ac = getCtx();
  if (ac.state === "running") return Promise.resolve();
  return ac.resume().then(() => undefined);
}

export function soundSet(
  which: "base" | "over",
  path: string | null,
  url: string | null,
  time: number,
  playing: boolean,
  gainLin: number,
): void {
  const c = chan(which);
  if (!path || !url) {
    c.el.pause();
    if (c.gain) c.gain.gain.value = 0;
    return;
  }
  if (c.path !== path || !c.el.getAttribute("src")) {
    if (c.hooked) rebuild(c);
    c.path = path;
    c.el.src = url;
  }
  try {
    hook(c);
  } catch {
    rebuild(c);
    c.path = path;
    c.el.src = url;
    try {
      hook(c);
    } catch {
      /* give up this frame */
    }
  }
  if (c.gain) c.gain.gain.value = Math.max(0, gainLin);
  c.el.muted = gainLin <= 0.001;
  c.el.volume = 1;
  const drift = Number.isFinite(c.el.currentTime) ? Math.abs(c.el.currentTime - time) : 99;
  const live = playing && !c.el.paused && !c.el.seeking;
  if (drift > (live ? 2.5 : 0.08) && !c.el.seeking) {
    try {
      c.el.currentTime = Math.max(0, time);
    } catch {
      /* ignore */
    }
  }
  if (playing) {
    if (c.el.paused && !c.el.seeking) void c.el.play().catch(() => {});
  } else if (!c.el.paused) {
    c.el.pause();
  }
}

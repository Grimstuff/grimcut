import { useEffect, useRef, useState, type ReactNode } from "react";
import { FONT_SIZE_STEPS, RES_BY_AR, arOf, stepFontSize, visualFontSize } from "../core/canvas";
import type { Clip, TextAlign } from "../core/types";
import { useEditor } from "../store/editorStore";
import { TextColorPop } from "./TextColorPop";
import { COMMON_FONTS, listSystemFonts } from "../lib/systemFonts";
import { applyPreviewVolume, noteUserSeek, syncPreviewToPlayhead, togglePlayback } from "../lib/playbackClock";

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

function splitTime(t: number) {
  const totalMs = Math.max(0, Math.round((Number.isFinite(t) ? t : 0) * 1000));
  const ms = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  return {
    h: Math.floor(total / 3600),
    m: Math.floor(total / 60) % 60,
    s: total % 60,
    ms,
  };
}

function clampSeg(h: number, m: number, s: number, ms: number) {
  while (ms >= 1000) {
    s += 1;
    ms -= 1000;
  }
  while (ms < 0) {
    s -= 1;
    ms += 1000;
  }
  while (s >= 60) {
    m += 1;
    s -= 60;
  }
  while (s < 0) {
    m -= 1;
    s += 60;
  }
  while (m >= 60) {
    h += 1;
    m -= 60;
  }
  while (m < 0) {
    h -= 1;
    m += 60;
  }
  if (h < 0) return { h: 0, m: 0, s: 0, ms: 0 };
  return { h, m, s, ms };
}

function partsToSec(p: { h: number; m: number; s: number; ms: number }) {
  const c = clampSeg(p.h, p.m, p.s, p.ms);
  return (c.h * 3600000 + c.m * 60000 + c.s * 1000 + c.ms) / 1000;
}

/** Parse 1:23:45.678, 1:23, 45.5, or a digit dump like 010203400 / 1500. */
function parseFlexibleTime(raw: string): number | null {
  const t = raw.trim().replace(/,/g, ".").replace(/[^\d:.]/g, "");
  if (!t) return null;
  if (/[:.]/.test(t)) {
    const dot = t.lastIndexOf(".");
    const main = dot >= 0 ? t.slice(0, dot) : t;
    const frac = dot >= 0 ? t.slice(dot + 1) : "";
    const parts = main.split(":").filter((x) => x.length > 0);
    let h = 0;
    let m = 0;
    let s = 0;
    if (parts.length >= 3) {
      h = Number(parts[0]) || 0;
      m = Number(parts[1]) || 0;
      s = Number(parts[2]) || 0;
    } else if (parts.length === 2) {
      m = Number(parts[0]) || 0;
      s = Number(parts[1]) || 0;
    } else {
      s = Number(parts[0]) || 0;
    }
    const ms = Number((frac + "000").slice(0, 3)) || 0;
    return partsToSec(clampSeg(h, m, s, ms));
  }
  const d = t.replace(/\D/g, "");
  if (!d) return null;
  const p = d.padStart(9, "0").slice(-9);
  return partsToSec(
    clampSeg(Number(p.slice(0, 2)), Number(p.slice(2, 4)), Number(p.slice(4, 6)), Number(p.slice(6, 9))),
  );
}

function seekTo(t: number) {
  useEditor.getState().setPlayhead(t);
  noteUserSeek();
  syncPreviewToPlayhead();
}

const LCD_MAX = [2, 2, 2, 3] as const;
const LCD_KEYS = ["h", "m", "s", "ms"] as const;

function LcdSeek({ playhead }: { playhead: number }) {
  const live = splitTime(playhead);
  const [edit, setEdit] = useState<string[] | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const refs = [
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
    useRef<HTMLInputElement>(null),
  ];
  const shown = edit ?? [pad(live.h, 2), pad(live.m, 2), pad(live.s, 2), pad(live.ms, 3)];

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      const hit = (e.target as HTMLElement | null)?.closest("[data-lcd]");
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(hit.getAttribute("data-lcd"));
      if (i < 0 || i > 3) return;
      const cur = splitTime(useEditor.getState().playhead);
      const arr = [cur.h, cur.m, cur.s, cur.ms];
      arr[i] += e.deltaY < 0 ? 1 : -1;
      const t = partsToSec(clampSeg(arr[0], arr[1], arr[2], arr[3]));
      seekTo(t);
      const n = splitTime(t);
      setEdit((prev) => (prev ? [pad(n.h, 2), pad(n.m, 2), pad(n.s, 2), pad(n.ms, 3)] : prev));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  const commit = (parts: string[]) => {
    const t = partsToSec(
      clampSeg(Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0, Number(parts[3]) || 0),
    );
    seekTo(t);
    const n = splitTime(t);
    setEdit([pad(n.h, 2), pad(n.m, 2), pad(n.s, 2), pad(n.ms, 3)]);
  };

  const startEdit = (i: number) => {
    const n = splitTime(useEditor.getState().playhead);
    setEdit([pad(n.h, 2), pad(n.m, 2), pad(n.s, 2), pad(n.ms, 3)]);
    requestAnimationFrame(() => refs[i].current?.select());
  };

  const onPaste = (e: React.ClipboardEvent, i: number) => {
    const text = e.clipboardData.getData("text");
    const t = parseFlexibleTime(text);
    if (t == null) return;
    e.preventDefault();
    seekTo(t);
    const n = splitTime(t);
    setEdit([pad(n.h, 2), pad(n.m, 2), pad(n.s, 2), pad(n.ms, 3)]);
    refs[Math.min(3, i)].current?.blur();
    setEdit(null);
  };

  const onChange = (i: number, raw: string) => {
    if (/[:.]/.test(raw) || raw.replace(/\D/g, "").length > LCD_MAX[i]) {
      const t = parseFlexibleTime(raw);
      if (t != null) {
        seekTo(t);
        const n = splitTime(t);
        const parts = [pad(n.h, 2), pad(n.m, 2), pad(n.s, 2), pad(n.ms, 3)];
        setEdit(parts);
        const digits = raw.replace(/\D/g, "");
        let idx = i;
        let used = 0;
        for (let k = i; k < 4; k++) {
          used += LCD_MAX[k];
          idx = k;
          if (digits.length <= used) break;
        }
        requestAnimationFrame(() => refs[idx].current?.select());
        return;
      }
    }
    const digits = raw.replace(/\D/g, "");
    const next = [...(edit ?? shown)];
    let cur = digits;
    let f = i;
    while (f < 4) {
      const max = LCD_MAX[f];
      if (cur.length <= max) {
        next[f] = cur;
        if (cur.length === max && f < 3) f++;
        break;
      }
      next[f] = cur.slice(0, max);
      cur = cur.slice(max);
      f++;
      if (f === 4) {
        next[3] = (next[3] + cur).slice(0, 3);
        f = 3;
        break;
      }
    }
    setEdit(next);
    commit(next);
    if (f !== i) requestAnimationFrame(() => refs[f].current?.select());
  };

  return (
    <div ref={rootRef} className="lcd" title="Playhead — click a segment to type, scroll to nudge">
      {LCD_KEYS.map((key, i) => (
        <span key={key} className="lcd-chunk" data-lcd={i}>
          {i > 0 ? <span className="lcd-sep">{i === 3 ? "." : ":"}</span> : null}
          <input
            ref={refs[i]}
            className="lcd-seg"
            inputMode="numeric"
            aria-label={key === "ms" ? "milliseconds" : key === "h" ? "hours" : key === "m" ? "minutes" : "seconds"}
            value={shown[i]}
            onFocus={() => startEdit(i)}
            onBlur={() => {
              if (edit) commit(edit);
              setTimeout(() => {
                if (!refs.some((r) => r.current === document.activeElement)) setEdit(null);
              }, 0);
            }}
            onPaste={(e) => onPaste(e, i)}
            onChange={(e) => onChange(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (edit) commit(edit);
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") {
                setEdit(null);
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === ":" || e.key === "." || e.key === "Tab") {
                if (e.key !== "Tab") e.preventDefault();
                const dir = e.shiftKey ? -1 : 1;
                const j = Math.max(0, Math.min(3, i + dir));
                if (e.key !== "Tab" || !e.shiftKey) {
                  if (e.key !== "Tab") refs[j].current?.select();
                }
              }
              if (e.key === "ArrowRight" && (e.target as HTMLInputElement).selectionStart === shown[i].length) {
                e.preventDefault();
                refs[Math.min(3, i + 1)].current?.select();
              }
              if (e.key === "ArrowLeft" && (e.target as HTMLInputElement).selectionStart === 0) {
                e.preventDefault();
                refs[Math.max(0, i - 1)].current?.select();
              }
              if (e.key === "Backspace" && !(e.target as HTMLInputElement).value) {
                e.preventDefault();
                refs[Math.max(0, i - 1)].current?.select();
              }
            }}
          />
        </span>
      ))}
    </div>
  );
}

function IconPlay() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M4.2 2.4v11.2L13.6 8 4.2 2.4z" />
    </svg>
  );
}
function IconPause() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M3.5 2.5h3v11h-3zm6 0h3v11h-3z" />
    </svg>
  );
}
function IconRecord() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.4" fill="currentColor" opacity="0.35" />
    </svg>
  );
}
function IconPaste() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M5.2 4.2h5.6v9.2H5.2zM6.4 4.2V2.8h3.2v1.4"
      />
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 8.2h2M7 10.4h2.8" />
    </svg>
  );
}
function IconText() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M3.2 3.5h9.6M8 3.5v9M5.5 12.5h5"
      />
    </svg>
  );
}
function FontSizeField({ clip }: { clip: Clip }) {
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const size = visualFontSize(clip);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [menuH, setMenuH] = useState(160);
  const shown = typed ?? String(size);

  const applyStep = (dir: 1 | -1) => {
    const live = useEditor.getState().project?.clips.find((c) => c.id === clip.id) ?? clip;
    const next = stepFontSize(visualFontSize(live), dir);
    setTyped(null);
    useEditor.getState().setTextProps(clip.id, { fontSize: next });
  };

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      applyStep(e.deltaY > 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [clip.id]);

  useEffect(() => {
    if (!open) return;
    const dock = wrap.current?.closest(".timeline-dock") as HTMLElement | null;
    const measure = () => {
      const r = wrap.current?.getBoundingClientRect();
      const dockR = dock?.getBoundingClientRect();
      if (!r) return;
      const floor = dockR ? dockR.bottom : window.innerHeight;
      setMenuH(Math.max(72, Math.min(240, floor - r.bottom - 10)));
    };
    measure();
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      applyStep(e.deltaY > 0 ? 1 : -1);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    window.addEventListener("resize", measure);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, clip.id]);

  useEffect(() => {
    if (!open) return;
    const el = menu.current?.querySelector(".is-on") as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  }, [open, size]);

  const commit = (raw: string) => {
    const n = Number(raw);
    setTyped(null);
    if (Number.isFinite(n) && n >= 6) useEditor.getState().setTextProps(clip.id, { fontSize: Math.min(400, Math.round(n)) });
  };

  return (
    <div className={`tb-fsize-wrap${open ? " is-open" : ""}`} ref={wrap} title="Font size — scroll the list">
      <div className="tb-fsize-face">
        <input
          ref={input}
          className="tb-fsize"
          value={shown}
          onFocus={() => setOpen(true)}
          onChange={(e) => setTyped(e.target.value.replace(/[^\d.]/g, ""))}
          onBlur={() => commit(typed ?? shown)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit((e.target as HTMLInputElement).value);
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <button
          type="button"
          className="tb-caret-hit"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tb-caret" />
        </button>
      </div>
      {open ? (
        <div className="tb-menu tb-fsize-menu" ref={menu} style={{ maxHeight: menuH }}>
          {FONT_SIZE_STEPS.map((n) => (
            <button
              key={n}
              type="button"
              className={n === size ? "is-on" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setTyped(null);
                useEditor.getState().setTextProps(clip.id, { fontSize: n });
                setOpen(false);
              }}
            >
              {n}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const lastAlign = new Map<string, TextAlign>();

function AlignToggle({ clip }: { clip: Clip }) {
  const align = clip.textAlign ?? "center";
  if (align !== "center") lastAlign.set(clip.id, align);
  const [hot, setHot] = useState(false);
  const held = useRef(false);
  const timer = useRef<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hot) return;
    const onDoc = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setHot(false);
    };
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [hot]);

  const pick = (a: TextAlign) => {
    if (a !== "center") lastAlign.set(clip.id, a);
    useEditor.getState().setTextProps(clip.id, { textAlign: a });
    setHot(false);
  };

  const Icon = align === "left" ? IconAlignLeft : align === "right" ? IconAlignRight : IconAlignCenter;

  return (
    <div className="tb-align-wrap" ref={wrap}>
      <button
        type="button"
        className={`icon-btn${align === "center" ? " is-on" : ""}`}
        title="Align — click to cycle, hold for all"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          held.current = false;
          timer.current = window.setTimeout(() => {
            held.current = true;
            setHot(true);
          }, 280);
        }}
        onPointerUp={() => {
          if (timer.current) {
            window.clearTimeout(timer.current);
            timer.current = null;
          }
          if (held.current) return;
          const order: TextAlign[] = ["left", "center", "right"];
          const i = order.indexOf(align);
          pick(order[(i + 1) % 3]);
        }}
        onPointerLeave={() => {
          if (timer.current) {
            window.clearTimeout(timer.current);
            timer.current = null;
          }
        }}
      >
        <Icon />
      </button>
      {hot ? (
        <div className="tb-float tb-align-hot">
          <button type="button" className={`icon-btn${align === "left" ? " is-on" : ""}`} title="Left" onClick={() => pick("left")}>
            <IconAlignLeft />
          </button>
          <button type="button" className={`icon-btn${align === "center" ? " is-on" : ""}`} title="Center" onClick={() => pick("center")}>
            <IconAlignCenter />
          </button>
          <button type="button" className={`icon-btn${align === "right" ? " is-on" : ""}`} title="Right" onClick={() => pick("right")}>
            <IconAlignRight />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function IconAlignLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3 4h10M3 8h7M3 12h10" />
    </svg>
  );
}
function IconAlignCenter() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3 4h10M5 8h6M3 12h10" />
    </svg>
  );
}
function IconAlignRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M3 4h10M6 8h7M3 12h10" />
    </svg>
  );
}
function IconCut() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        d="M3.2 3.2c1.6 1.6 4.2 5.2 4.8 4.8M3.2 12.8c1.6-1.6 4.2-5.2 4.8-4.8M12.8 3.2 8 8l4.8 4.8"
      />
      <circle cx="3.4" cy="3.4" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="3.4" cy="12.6" r="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
function IconDelete() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.5 4.5h9M6 4.5V3.2h4v1.3M5.2 4.5l.5 8.2h4.6l.5-8.2"
      />
    </svg>
  );
}
function IconExport() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 9.5V2.8M5.2 5 8 2.5 10.8 5M3.2 9.2v3.6h9.6V9.2"
      />
    </svg>
  );
}
function IconMonitor() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="8.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M8 11v2.2M5.2 13.5h5.6" />
    </svg>
  );
}

function IconArWide() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      <rect x="1.2" y="3.2" width="19.6" height="9.6" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="2.6" y="4.6" width="16.8" height="6.8" rx="0.4" fill="currentColor" opacity="0.18" />
    </svg>
  );
}
function IconArCrt() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      <rect x="3.2" y="1.6" width="15.6" height="11.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="5" y="3.2" width="12" height="8" rx="0.6" fill="currentColor" opacity="0.18" />
      <path fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" d="M8.2 14.2h5.6" />
    </svg>
  );
}
function IconArSquare() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      <rect x="4.6" y="1.6" width="12.8" height="12.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="6.2" y="3.2" width="9.6" height="9.6" rx="0.4" fill="currentColor" opacity="0.18" />
    </svg>
  );
}
function IconArPhone() {
  return (
    <svg width="22" height="16" viewBox="0 0 22 16" aria-hidden="true">
      <rect x="7.4" y="0.6" width="7.2" height="14.8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <rect x="8.6" y="2.2" width="4.8" height="10.2" rx="0.35" fill="currentColor" opacity="0.18" />
      <path fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" d="M9.8 13.8h2.4" />
    </svg>
  );
}

const AR_ICONS: { id: string; title: string; Icon: () => ReactNode }[] = [
  { id: "16:9", title: "Widescreen 16:9", Icon: IconArWide },
  { id: "4:3", title: "CRT 4:3", Icon: IconArCrt },
  { id: "1:1", title: "Square 1:1", Icon: IconArSquare },
  { id: "9:16", title: "Phone 9:16", Icon: IconArPhone },
];
function IconSpeaker({ muted }: { muted: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path fill="currentColor" d="M2.8 6.1h2.1L8 3.6v8.8L4.9 9.9H2.8z" />
      {!muted ? (
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          d="M10.2 6.1c.8.7.8 3.1 0 3.8M12.1 4.6c1.6 1.5 1.6 5.3 0 6.8"
        />
      ) : (
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M10.4 6.2 13 9.4M13 6.2l-2.6 3.2" />
      )}
    </svg>
  );
}

function parseRes(text: string): { w: number; h: number } | null {
  const m = text.trim().match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w < 16 || h < 16) return null;
  return { w, h };
}

export function TransportBar() {
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedId = useEditor((s) => s.selectedId);
  const range = useEditor((s) => s.range);
  const busy = useEditor((s) => s.busy);
  const clipboard = useEditor((s) => s.clipboard);
  const volume = useEditor((s) => s.previewVolume);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [resOpen, setResOpen] = useState(false);
  const [resText, setResText] = useState("");
  const [volHint, setVolHint] = useState(false);
  const [sysFonts, setSysFonts] = useState<string[]>([]);
  const wrap = useRef<HTMLDivElement>(null);
  const lastVol = useRef(1);

  useEffect(() => {
    if (!project) return;
    setResText(`${project.canvasWidth} × ${project.canvasHeight}`);
  }, [project?.canvasWidth, project?.canvasHeight]);

  useEffect(() => {
    applyPreviewVolume(volume);
  }, [volume]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) {
        setCanvasOpen(false);
        setResOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!project) return null;

  const ar = arOf(project.canvasWidth, project.canvasHeight);
  const resList = RES_BY_AR[ar] ?? RES_BY_AR["16:9"];
  const rangeDur = range ? Math.abs(range.end - range.start) : 0;
  const selected = project.clips.find((c) => c.id === selectedId);
  const canCut = rangeDur > 0.04;
  const onClip = project.clips.some(
    (c) => playhead > c.timelineStart && playhead < c.timelineStart + (c.sourceEnd - c.sourceStart),
  );
  const canDel = !!selected || canCut;
  const muted = volume <= 0.001;
  const textClip = selected?.kind === "text" ? selected : null;
  const fonts = COMMON_FONTS;

  const applyTyped = () => {
    const parsed = parseRes(resText);
    if (parsed) useEditor.getState().setCanvas(parsed.w, parsed.h);
    else setResText(`${project.canvasWidth} × ${project.canvasHeight}`);
  };

  return (
    <div className="tl-bar" ref={wrap}>
      <div className="tl-bar-left">
        {textClip ? (
          <div className="tb-props">
            <select
              className="tb-font"
              title="Font"
              value={textClip.fontFamily ?? "Segoe UI"}
              onFocus={() => {
                if (sysFonts.length === 0) void listSystemFonts().then(setSysFonts);
              }}
              onChange={(e) => useEditor.getState().setTextProps(textClip.id, { fontFamily: e.target.value })}
            >
              {!fonts.includes(textClip.fontFamily ?? "Segoe UI") &&
              !sysFonts.includes(textClip.fontFamily ?? "") ? (
                <option value={textClip.fontFamily}>{textClip.fontFamily}</option>
              ) : null}
              <optgroup label="Common">
                {fonts.map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f }}>
                    {f}
                  </option>
                ))}
              </optgroup>
              {sysFonts.length > 0 ? (
                <optgroup label="System">
                  {sysFonts.map((f) => (
                    <option key={f} value={f} style={{ fontFamily: f }}>
                      {f}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
            <FontSizeField clip={textClip} />
            <TextColorPop clip={textClip} />
            <AlignToggle clip={textClip} />
          </div>
        ) : (
        <>
        <div
          className="tb-vol"
          onPointerEnter={() => setVolHint(true)}
          onPointerLeave={() => setVolHint(false)}
        >
          <button
            type="button"
            className="icon-btn"
            title={muted ? "Unmute preview" : "Mute preview"}
            onClick={() => {
              if (muted) {
                const v = lastVol.current || 0.8;
                useEditor.getState().setPreviewVolume(v);
                applyPreviewVolume(v);
              } else {
                lastVol.current = volume;
                useEditor.getState().setPreviewVolume(0);
                applyPreviewVolume(0);
              }
            }}
          >
            <IconSpeaker muted={muted} />
          </button>
          <span className="tb-vol-track">
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              aria-label="Preview volume"
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) lastVol.current = v;
                useEditor.getState().setPreviewVolume(v);
                applyPreviewVolume(v);
              }}
            />
            {volHint ? (
              <span className="tb-vol-pct" style={{ left: `${volume * 100}%` }}>
                {Math.round(volume * 100)}%
              </span>
            ) : null}
          </span>
        </div>
        <div className="tb-canvas-wrap">
          <button
            type="button"
            className={`icon-btn${canvasOpen ? " is-on" : ""}`}
            title="Canvas size and aspect ratio"
            onClick={() => {
              setCanvasOpen((v) => !v);
              setResOpen(false);
            }}
          >
            <IconMonitor />
          </button>
          {canvasOpen ? (
            <div className="tb-float tb-pop">
              <div className="tb-ar-row">
                {AR_ICONS.map(({ id, title, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    className={`tb-ar-btn${ar === id ? " is-on" : ""}`}
                    title={title}
                    onClick={() => {
                      if (id !== ar) useEditor.getState().setCanvasPreset(id);
                    }}
                  >
                    <Icon />
                  </button>
                ))}
              </div>
              <div className={`tb-combo${resOpen ? " is-open" : ""}`}>
                <div className="tb-combo-face tb-combo-fill">
                  <input
                    className="tb-res-input"
                    value={resText}
                    title="Canvas resolution"
                    onFocus={() => setResOpen(true)}
                    onChange={(e) => setResText(e.target.value)}
                    onBlur={applyTyped}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        applyTyped();
                        setResOpen(false);
                        (e.target as HTMLInputElement).blur();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="tb-caret-hit"
                    title="Common resolutions"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => setResOpen((v) => !v)}
                  >
                    <span className="tb-caret" />
                  </button>
                </div>
                {resOpen ? (
                  <div className="tb-menu tb-menu-wide">
                    {resList.map((r) => (
                      <button
                        key={r.label}
                        type="button"
                        className={r.w === project.canvasWidth && r.h === project.canvasHeight ? "is-on" : ""}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          useEditor.getState().setCanvas(r.w, r.h);
                          setResOpen(false);
                        }}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        </>
        )}
      </div>

      <div className="tl-bar-center">
        <button type="button" className="icon-btn icon-btn-lg is-record" title="Record (coming later)" disabled>
          <IconRecord />
        </button>
        <LcdSeek playhead={playhead} />
        <button
          type="button"
          className={`icon-btn icon-btn-lg${playing ? " is-on" : ""}`}
          title="Play / pause (Space)"
          onClick={() => togglePlayback()}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
      </div>

      <div className="tl-bar-right">
        <div className="tb-group">
          <button type="button" className="icon-btn" title="Add text layer" onClick={() => useEditor.getState().addTextClip()}>
            <IconText />
          </button>
        </div>
        <div className="tb-group">
          {clipboard ? (
            <button
              type="button"
              className="icon-btn"
              title="Paste at playhead (Ctrl+V)"
              onClick={() => useEditor.getState().paste()}
            >
              <IconPaste />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              title={canCut ? "Cut selected range (Ctrl+X)" : "Slice at playhead (Ctrl+X / S)"}
              disabled={!canCut && !onClip}
              onClick={() => useEditor.getState().cutOrSlice()}
            >
              <IconCut />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Delete clip or range (Delete)"
            disabled={!canDel}
            onClick={() => useEditor.getState().del()}
          >
            <IconDelete />
          </button>
        </div>
        <div className="tb-group tb-export-group">
          <button
            type="button"
            className="icon-btn icon-export"
            title="Export / save (Ctrl+S)"
            disabled={busy}
            onClick={() => void useEditor.getState().exportVideo()}
          >
            <IconExport />
          </button>
        </div>
      </div>
    </div>
  );
}

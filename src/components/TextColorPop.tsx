import { useEffect, useRef, useState } from "react";
import { contrastInk } from "../core/canvas";
import type { Clip } from "../core/types";
import { useEditor } from "../store/editorStore";

const PRESET_SWATCHES = ["#ffffff", "#000000"];
const STARTER_HISTORY = ["#ff3366", "#ff6b00", "#ffcc00", "#00c853", "#5eb0ff"];
const HIST_KEY = "grimcut.colorHistory";

function loadHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(HIST_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((x) => parseHex(String(x))).filter((x): x is string => !!x && !PRESET_SWATCHES.includes(x)).slice(0, 5);
  } catch {
    return [];
  }
}

function saveHistory(list: string[]) {
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    /* ignore */
  }
}

function historySlots(hist: string[]) {
  const extra = STARTER_HISTORY.filter((c) => !hist.includes(c));
  return [...hist, ...extra].slice(0, 5);
}

type Hsv = { h: number; s: number; v: number };

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const t = hex.trim().replace(/^#/, "");
  const s = t.length === 3 ? t[0] + t[0] + t[1] + t[1] + t[2] + t[2] : t;
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

function rgbToHex(r: number, g: number, b: number) {
  return (
    "#" +
    [r, g, b]
      .map((n) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToRgb(h: number, s: number, v: number) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function hsvToHex(hsv: Hsv) {
  const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
  return rgbToHex(r, g, b);
}

function parseHex(raw: string): string | null {
  const rgb = hexToRgb(raw);
  return rgb ? rgbToHex(rgb.r, rgb.g, rgb.b) : null;
}

async function eyeDrop(): Promise<string | null> {
  const Ctor = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  if (!Ctor) return null;
  try {
    const r = await new Ctor().open();
    return parseHex(r.sRGBHex);
  } catch {
    return null;
  }
}

export function TextColorPop({ clip }: { clip: Clip }) {
  const clipId = clip.id;
  const color = clip.textColor ?? "#ffffff";
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const hex0 = parseHex(color) ?? "#ffffff";
  const rgb0 = hexToRgb(hex0)!;
  const [hsv, setHsv] = useState<Hsv>(() => rgbToHsv(rgb0.r, rgb0.g, rgb0.b));
  const [hexText, setHexText] = useState(hex0.replace("#", "").toUpperCase());
  const picking = useEditor((s) => s.colorPickId === clipId);
  const ink = contrastInk(hex0);
  const [hist, setHist] = useState<string[]>(loadHistory);
  const slots = historySlots(hist);

  const remember = (hex: string) => {
    const n = parseHex(hex);
    if (!n || PRESET_SWATCHES.includes(n)) return;
    setHist((prev) => {
      const next = [n, ...prev.filter((c) => c !== n)].slice(0, 5);
      saveHistory(next);
      return next;
    });
  };

  useEffect(() => {
    const next = parseHex(color) ?? "#ffffff";
    const rgb = hexToRgb(next)!;
    setHsv(rgbToHsv(rgb.r, rgb.g, rgb.b));
    setHexText(next.replace("#", "").toUpperCase());
  }, [color, open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const apply = (next: Hsv | string, opts?: { fromHex?: boolean; remember?: boolean }) => {
    const hex = typeof next === "string" ? parseHex(next) : hsvToHex(next);
    if (!hex) return;
    if (typeof next !== "string") setHsv(next);
    else {
      const rgb = hexToRgb(hex)!;
      setHsv(rgbToHsv(rgb.r, rgb.g, rgb.b));
    }
    if (!opts?.fromHex) setHexText(hex.replace("#", "").toUpperCase());
    useEditor.getState().setTextProps(clipId, { textColor: hex }, { hug: false });
    if (opts?.remember) remember(hex);
  };

  const startPick = async () => {
    useEditor.getState().setColorPick(clipId);
    const hex = await eyeDrop();
    if (hex) {
      apply(hex, { remember: true });
      useEditor.getState().setColorPick(null);
      return;
    }
    setOpen(false);
  };

  return (
    <div className="tb-color-wrap" ref={root}>
      <button
        type="button"
        className={`tb-color-chip${open ? " is-on" : ""}`}
        title="Text color"
        style={{ background: hex0 }}
        onClick={() => {
          setOpen((v) => !v);
          useEditor.getState().setColorPick(null);
        }}
      />
      {open ? (
        <div className="tb-float tb-color-pop" onMouseDown={(e) => e.stopPropagation()}>
          <SvPad hsv={hsv} onChange={(next) => apply(next)} onCommit={(next) => apply(next, { remember: true })} />
          <HueBar h={hsv.h} onChange={(h) => apply({ ...hsv, h })} onCommit={(h) => apply({ ...hsv, h }, { remember: true })} />
          <div className="tb-swatches">
            {PRESET_SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`tb-swatch is-preset${hex0 === c ? " is-on" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => apply(c)}
              />
            ))}
            {slots.map((c) => (
              <button
                key={c}
                type="button"
                className={`tb-swatch${hex0 === c ? " is-on" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => apply(c, { remember: true })}
              />
            ))}
          </div>
          <div className="tb-color-foot">
            <div className={`tb-hex-unit${picking ? " is-pick" : ""}`}>
              <span className="tb-hex-hash">#</span>
              <input
                className="tb-hex"
                value={hexText}
                spellCheck={false}
                maxLength={6}
                title="Hex color"
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6);
                  setHexText(v.toUpperCase());
                  if (v.length === 6) apply(v, { fromHex: true, remember: true });
                }}
                onBlur={() => {
                  const hex = parseHex(hexText);
                  if (hex) apply(hex, { remember: true });
                  else setHexText(hex0.replace("#", "").toUpperCase());
                }}
              />
              <button type="button" className="tb-hex-drop" title="Eyedropper — sample the preview" onClick={() => void startPick()}>
                <IconDropper />
              </button>
            </div>
            <div className="tb-fx">
              <button
                type="button"
                className={`tb-fx-btn${clip.textShadow ? " is-on" : ""}`}
                title="Drop shadow"
                onClick={() => useEditor.getState().setTextProps(clipId, { textShadow: !clip.textShadow }, { hug: false })}
              >
                <IconShadow fill={hex0} />
              </button>
              <button
                type="button"
                className={`tb-fx-btn${clip.textStroke ? " is-on" : ""}`}
                title="Outline stroke"
                onClick={() => useEditor.getState().setTextProps(clipId, { textStroke: !clip.textStroke }, { hug: false })}
              >
                <IconStroke ink={ink} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SvPad({ hsv, onChange, onCommit }: { hsv: Hsv; onChange: (h: Hsv) => void; onCommit?: (h: Hsv) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(hsv);
  live.current = hsv;
  const drag = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const s = clamp((e.clientX - r.left) / r.width, 0, 1);
    const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    onChange({ ...hsv, s, v });
  };
  return (
    <div
      ref={ref}
      className="tb-sv"
      style={{ backgroundColor: `hsl(${hsv.h}, 100%, 50%)` }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e);
      }}
      onPointerUp={() => onCommit?.(live.current)}
    >
      <span className="tb-sv-knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
    </div>
  );
}

function HueBar({ h, onChange, onCommit }: { h: number; onChange: (h: number) => void; onCommit?: (h: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const live = useRef(h);
  live.current = h;
  const drag = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(clamp(((e.clientX - r.left) / r.width) * 360, 0, 359.9));
  };
  return (
    <div
      ref={ref}
      className="tb-hue"
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e);
      }}
      onPointerUp={() => onCommit?.(live.current)}
    >
      <span className="tb-hue-knob" style={{ left: `${(h / 360) * 100}%` }} />
    </div>
  );
}

function IconDropper() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M10.2 2.4 13.6 5.8M12.2 4.4 6.8 9.8l-1.7 3.1 3.1-1.7 5.4-5.4M5.4 10.2 3.2 12.4c-.6.6-.6 1.6 0 2.2.6.6 1.6.6 2.2 0l2.2-2.2"
      />
    </svg>
  );
}

function IconShadow({ fill }: { fill: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <text x="5.2" y="12.2" fontSize="11" fontFamily="Segoe UI, sans-serif" fontWeight="700" fill="#000" opacity="0.7">
        T
      </text>
      <text x="3.4" y="11" fontSize="11" fontFamily="Segoe UI, sans-serif" fontWeight="700" fill={fill} stroke="#000" strokeWidth="0.4">
        T
      </text>
    </svg>
  );
}

function IconStroke({ ink }: { ink: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <text
        x="3.6"
        y="12"
        fontSize="12"
        fontFamily="Segoe UI, sans-serif"
        fontWeight="700"
        fill="none"
        stroke={ink}
        strokeWidth="1.15"
      >
        T
      </text>
    </svg>
  );
}

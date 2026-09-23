import { invoke } from "@tauri-apps/api/core";

export interface AccentColors {
  background: string;
  foreground: string;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function darkenHex(hex: string, amount: number): string {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const f = 1 - amount;
  return toHex(rgb.r * f, rgb.g * f, rgb.b * f);
}

/** Solid action buttons only (Export, About OK). Rest of UI stays Fluent blue. */
export function applyAccentToDom(colors: AccentColors) {
  const root = document.documentElement;
  root.style.setProperty("--gp-win-accent", colors.background);
  root.style.setProperty("--gp-win-accent-hover", darkenHex(colors.background, 0.12));
  root.style.setProperty("--gp-win-accent-fg", colors.foreground);
}

export async function fetchSystemAccent(): Promise<AccentColors | null> {
  try {
    return await invoke<AccentColors>("get_system_accent");
  } catch (e) {
    console.warn("get_system_accent failed", e);
    return null;
  }
}

export function initSystemAccent(): () => void {
  let cancelled = false;

  const refresh = async () => {
    const colors = await fetchSystemAccent();
    if (!cancelled && colors) applyAccentToDom(colors);
  };

  void refresh();

  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void refresh();
  });

  return () => {
    cancelled = true;
    window.removeEventListener("focus", onFocus);
  };
}

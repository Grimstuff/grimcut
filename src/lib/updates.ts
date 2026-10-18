import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";

const RELEASES_URL = "https://github.com/Grimstuff/grimcut/releases/latest";

export type UpdatePhase = "checking" | "available" | "none" | "downloading" | "error";

interface UpdateState {
  open: boolean;
  phase: UpdatePhase;
  version: string;
  notes: string;
  /** Installer copy can update in place; the portable exe gets a download link. */
  installed: boolean;
  /** 0..1, or null while the size is unknown. */
  progress: number | null;
  error: string;
}

export const useUpdateStore = create<UpdateState>(() => ({
  open: false,
  phase: "none",
  version: "",
  notes: "",
  installed: false,
  progress: null,
  error: "",
}));

let pending: Update | null = null;
let busy = false;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The latest release has no latest.json (one published before the updater existed). */
function isMissingManifest(e: unknown): boolean {
  return /valid release JSON/i.test(errorText(e));
}

/** Ask GitHub for a newer release. Only runs from the menu: Grimcut never checks on its own. */
export async function checkForUpdates(): Promise<void> {
  if (busy) return;
  busy = true;
  useUpdateStore.setState({ open: true, phase: "checking", error: "" });
  try {
    const update = await check();
    if (!update) {
      useUpdateStore.setState({ phase: "none" });
      return;
    }
    pending = update;
    const installed = await invoke<boolean>("is_installed_copy").catch(() => false);
    useUpdateStore.setState({
      open: true,
      phase: "available",
      version: update.version,
      notes: update.body?.trim() ?? "",
      installed,
      progress: null,
      error: "",
    });
  } catch (e) {
    console.warn("update check failed", e);
    useUpdateStore.setState(
      isMissingManifest(e) ? { phase: "none" } : { phase: "error", error: errorText(e) },
    );
  } finally {
    busy = false;
  }
}

/** Download, then hand off to the installer. Windows exits the app and the installer reopens it. */
export async function installUpdate(): Promise<void> {
  const update = pending;
  if (!update || busy) return;
  busy = true;
  useUpdateStore.setState({ phase: "downloading", progress: null, error: "" });
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((ev) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
      } else if (ev.event === "Progress") {
        done += ev.data.chunkLength;
        if (total > 0) useUpdateStore.setState({ progress: Math.min(1, done / total) });
      }
    });
  } catch (e) {
    console.warn("update install failed", e);
    useUpdateStore.setState({ phase: "error", error: errorText(e) });
  } finally {
    busy = false;
  }
}

export function openDownloadPage(): void {
  void openUrl(RELEASES_URL).catch((e) => console.warn("open releases page failed", e));
  closeUpdateDialog();
}

export function closeUpdateDialog(): void {
  if (useUpdateStore.getState().phase === "downloading") return;
  useUpdateStore.setState({ open: false });
}

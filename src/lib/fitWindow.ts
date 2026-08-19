export function chromeExtra(): number {
  return (
    ((document.querySelector(".chrome") as HTMLElement | null)?.offsetHeight ?? 40) +
    ((document.querySelector(".timeline") as HTMLElement | null)?.offsetHeight ?? 196) +
    ((document.querySelector(".status") as HTMLElement | null)?.offsetHeight ?? 26)
  );
}

/** Window width that makes the preview pane match `aspect` at this window height. */
export function lockedWidthForHeight(winH: number, aspect: number): number {
  const previewH = Math.max(80, winH - chromeExtra());
  return Math.max(720, Math.round(aspect * previewH));
}

/** Size the window so the preview pane matches the video aspect (no bars at rest). */
export async function fitWindowToVideo(vw: number, vh: number) {
  if (!vw || !vh) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const extra = chromeExtra();

    const aspect = vw / vh;
    const minW = 720;
    const minH = 480;
    const maxW = Math.min(1800, window.screen.availWidth - 40);
    const maxH = Math.min(1100, window.screen.availHeight - 80);

    let previewH = 520;
    let winW = Math.round(aspect * previewH);
    let winH = Math.round(previewH + extra);

    if (winW < minW) {
      winW = minW;
      previewH = winW / aspect;
      winH = Math.round(previewH + extra);
    }
    if (winW > maxW) {
      winW = maxW;
      previewH = winW / aspect;
      winH = Math.round(previewH + extra);
    }
    winH = Math.max(minH, Math.min(maxH, winH));
    winW = Math.max(minW, Math.min(maxW, winW));

    await getCurrentWindow().setSize(new LogicalSize(winW, winH));
  } catch {
    /* browser / permissions */
  }
}

/** Push aspect + chrome height to the native WM_SIZING hook (MPC-style). */
export async function pushAspectLock(aspect: number | null) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_aspect_lock", {
      aspect: aspect && aspect > 0 ? aspect : 0,
      extra: chromeExtra(),
      enabled: !!(aspect && aspect > 0),
    });
  } catch {
    /* browser */
  }
}

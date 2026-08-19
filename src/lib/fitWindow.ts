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

/**
 * MPC-style resize: height (or corner) drags keep the window at the video aspect.
 * Pure horizontal drags may go *wider* than the video (pillarbox + longer timeline),
 * but not narrower.
 */
export async function attachAspectLock(aspect: number): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalSize } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  const factor = await win.scaleFactor();
  const inner = await win.innerSize();
  let lastH = inner.height / factor;
  void inner.width;
  let busy = false;

  const unlisten = await win.onResized(async (ev) => {
    if (busy || !aspect) return;
    try {
      if (await win.isMaximized()) return;
    } catch {
      /* ignore */
    }
    const f = await win.scaleFactor();
    const w = ev.payload.width / f;
    const h = ev.payload.height / f;
    const dh = Math.abs(h - lastH);
    const locked = lockedWidthForHeight(h, aspect);
    const maxW = Math.min(2400, window.screen.availWidth - 16);

    let nextW = w;
    let nextH = h;
    if (dh >= 2) {
      nextW = Math.min(maxW, locked);
    } else {
      nextW = Math.min(maxW, Math.max(w, locked));
    }

    lastH = nextH;
    if (Math.abs(nextW - w) < 1.5 && Math.abs(nextH - h) < 1.5) return;
    busy = true;
    try {
      await win.setSize(new LogicalSize(Math.round(nextW), Math.round(nextH)));
    } catch {
      /* ignore */
    } finally {
      busy = false;
    }
  });

  return unlisten;
}

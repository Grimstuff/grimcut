/** Size the window so the preview pane matches the video aspect (no bars at rest). */
export async function fitWindowToVideo(vw: number, vh: number) {
  if (!vw || !vh) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const { LogicalSize } = await import("@tauri-apps/api/dpi");
    const extra =
      ((document.querySelector(".chrome") as HTMLElement | null)?.offsetHeight ?? 40) +
      ((document.querySelector(".timeline") as HTMLElement | null)?.offsetHeight ?? 196) +
      ((document.querySelector(".status") as HTMLElement | null)?.offsetHeight ?? 26);

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

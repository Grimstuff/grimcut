//! Media Player Classic-style aspect lock via WM_SIZING.
//! The cursor is free; Windows asks us to rewrite the drag rectangle before apply.

use std::sync::Mutex;
use tauri::WebviewWindow;

struct AspectLock {
    enabled: bool,
    /// video width / height
    aspect: f64,
    /// chrome + timeline + status, CSS/logical pixels
    extra_logical: f64,
    min_w_logical: f64,
}

static LOCK: Mutex<AspectLock> = Mutex::new(AspectLock {
    enabled: false,
    aspect: 16.0 / 9.0,
    extra_logical: 262.0,
    min_w_logical: 720.0,
});

pub fn set_lock(aspect: f64, extra_logical: f64, enabled: bool) {
    if let Ok(mut g) = LOCK.lock() {
        g.enabled = enabled && aspect > 0.2 && aspect < 8.0;
        g.aspect = aspect;
        if extra_logical > 40.0 {
            g.extra_logical = extra_logical;
        }
    }
}

#[cfg(windows)]
mod win {
    use super::LOCK;
    use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
    use std::sync::atomic::AtomicIsize;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GetWindowRect, SetWindowLongPtrW, GWLP_WNDPROC, HTLEFT, HTRIGHT,
        WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCHITTEST, WM_SIZING, WMSZ_BOTTOMLEFT, WMSZ_LEFT,
        WMSZ_RIGHT, WMSZ_TOPLEFT,
    };

    static INSTALLED: AtomicBool = AtomicBool::new(false);
    static ORIG_PROC: AtomicIsize = AtomicIsize::new(0);
    static LAST_LOCKED_W: AtomicI32 = AtomicI32::new(0);

    pub fn install(window: &tauri::WebviewWindow) {
        if INSTALLED.swap(true, Ordering::SeqCst) {
            return;
        }
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = HWND(hwnd.0 as *mut std::ffi::c_void);
        unsafe {
            let orig = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wnd_proc as *const () as usize as isize);
            ORIG_PROC.store(orig, Ordering::SeqCst);
        }
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_ENTERSIZEMOVE || msg == WM_EXITSIZEMOVE {
            LAST_LOCKED_W.store(0, Ordering::SeqCst);
        }
        if msg == WM_SIZING {
            constrain(hwnd, wparam.0 as u32, lparam);
        }
        if msg == WM_NCHITTEST {
            if let Some(hit) = side_hit(hwnd, lparam) {
                return LRESULT(hit);
            }
        }
        let orig = ORIG_PROC.load(Ordering::SeqCst);
        unsafe {
            CallWindowProcW(
                Some(std::mem::transmute(orig)),
                hwnd,
                msg,
                wparam,
                lparam,
            )
        }
    }

    fn constrain(hwnd: HWND, edge: u32, lparam: LPARAM) {
        let Ok(lock) = LOCK.lock() else {
            return;
        };
        if !lock.enabled {
            return;
        }
        let dpi = unsafe { GetDpiForWindow(hwnd) }.max(96) as f64;
        let scale = dpi / 96.0;
        let extra = (lock.extra_logical * scale).round() as i32;
        let min_w = (lock.min_w_logical * scale).round() as i32;
        let aspect = lock.aspect;
        drop(lock);

        let rect = unsafe { &mut *(lparam.0 as *mut RECT) };
        let h = rect.bottom - rect.top;
        // Even preview height so 1px mouse jitter doesn't flip the derived width.
        let preview_h = ((h - extra).max(80) / 2) * 2;
        let mut locked_w = ((aspect * preview_h as f64).round() as i32).max(min_w);
        locked_w = (locked_w / 2) * 2;
        let last = LAST_LOCKED_W.load(Ordering::SeqCst);
        if last != 0 && (locked_w - last).abs() <= 2 {
            locked_w = last;
        } else {
            LAST_LOCKED_W.store(locked_w, Ordering::SeqCst);
        }

        let left_edge = matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT);
        let side_only = matches!(edge, WMSZ_LEFT | WMSZ_RIGHT);

        if side_only {
            let w = rect.right - rect.left;
            if w < locked_w {
                apply_width(rect, left_edge, locked_w);
            }
        } else {
            apply_width(rect, left_edge, locked_w);
        }
    }

    /// Prefer HTLEFT/HTRIGHT on the mid-sides so a rightward drag isn't BOTTOMRIGHT.
    fn side_hit(hwnd: HWND, lparam: LPARAM) -> Option<isize> {
        let mut wr = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut wr) }.ok()?;
        let x = (lparam.0 as i32) & 0xffff;
        let y = ((lparam.0 as u32) >> 16) as i32;
        // GET_X_LPARAM sign-extend
        let x = x as i16 as i32;
        let y = y as i16 as i32;
        let w = wr.right - wr.left;
        let h = wr.bottom - wr.top;
        let edge = 10i32;
        let corner = 22i32;
        if y < wr.top + corner || y > wr.bottom - corner {
            return None;
        }
        if x >= wr.left && x <= wr.left + edge {
            return Some(HTLEFT as isize);
        }
        if x <= wr.right && x >= wr.right - edge {
            return Some(HTRIGHT as isize);
        }
        let _ = (w, h);
        None
    }

    fn apply_width(rect: &mut RECT, keep_right: bool, w: i32) {
        if keep_right {
            rect.left = rect.right - w;
        } else {
            rect.right = rect.left + w;
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn install(_: &tauri::WebviewWindow) {}
}

pub fn install_hook(window: &WebviewWindow) {
    win::install(window);
}

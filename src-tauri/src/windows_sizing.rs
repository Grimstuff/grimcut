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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::atomic::AtomicIsize;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, GetWindowRect, SetWindowLongPtrW, GWLP_WNDPROC, WM_SIZING, WMSZ_BOTTOMLEFT,
        WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOPLEFT,
    };

    static INSTALLED: AtomicBool = AtomicBool::new(false);
    static ORIG_PROC: AtomicIsize = AtomicIsize::new(0);

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
        if msg == WM_SIZING {
            constrain(hwnd, wparam.0 as u32, lparam);
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
        let mut current = RECT::default();
        let _ = unsafe { GetWindowRect(hwnd, &mut current) };
        let dw = (rect.right - rect.left) - (current.right - current.left);
        let dh = (rect.bottom - rect.top) - (current.bottom - current.top);

        let h = rect.bottom - rect.top;
        let preview_h = (h - extra).max(80);
        let locked_w = ((aspect * preview_h as f64).round() as i32).max(min_w);
        let left_edge = matches!(edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT);
        let side_only = matches!(edge, WMSZ_LEFT | WMSZ_RIGHT);
        // Frameless hits often report BOTTOMRIGHT for a right-edge drag. If width
        // is clearly the main motion, treat it as horizontal — don't AR-snap width.
        let width_dominant = side_only || (dw.abs() > 2 && dw.abs() >= dh.abs() * 2);

        if width_dominant {
            rect.top = current.top;
            rect.bottom = current.bottom;
            let preview_h = (current.bottom - current.top - extra).max(80);
            let locked_w = ((aspect * preview_h as f64).round() as i32).max(min_w);
            let w = rect.right - rect.left;
            if w < locked_w {
                apply_width(rect, left_edge, locked_w);
            }
        } else {
            apply_width(rect, left_edge, locked_w);
        }
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

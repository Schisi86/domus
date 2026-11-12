//! Annotation overlay: a transparent, click-through window on top of the shared
//! monitor that shows what viewers draw or point at ("draw on the stream").
//! The window is excluded from screen capture, so the picture that is sent
//! stays clean – every client draws the marks itself on top of the stream.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::remotectl;

const LABEL: &str = "ink";

/// Shows the overlay on the shared monitor (or hides and closes it).
#[tauri::command]
pub async fn ink_overlay(app: AppHandle, show: bool) -> Result<bool, String> {
    if !show {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.destroy();
        }
        return Ok(false);
    }
    let Some(rect) = remotectl::target_rect() else {
        return Ok(false);
    };
    if let Some(w) = app.get_webview_window(LABEL) {
        place(&w, rect);
        return Ok(true);
    }
    let w = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("ink.html".into()))
        .title("Domus – Markierungen")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .focused(false)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = w.set_ignore_cursor_events(true);
    place(&w, rect);
    exclude_from_capture(&w);
    let _ = w.show();
    Ok(true)
}

fn place(w: &tauri::WebviewWindow, r: remotectl::Rect) {
    let _ = w.set_position(tauri::PhysicalPosition::new(r.x, r.y));
    let _ = w.set_size(tauri::PhysicalSize::new(r.w.max(1) as u32, r.h.max(1) as u32));
}

#[cfg(windows)]
fn exclude_from_capture(w: &tauri::WebviewWindow) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    if let Ok(hwnd) = w.hwnd() {
        // SAFETY: the handle belongs to a live window of this process.
        unsafe { SetWindowDisplayAffinity(hwnd.0 as _, WDA_EXCLUDEFROMCAPTURE) };
    }
}

#[cfg(not(windows))]
fn exclude_from_capture(_w: &tauri::WebviewWindow) {}

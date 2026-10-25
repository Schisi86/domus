//! Hides WebView2's floating "… is sharing your screen · Stop sharing · Hide"
//! bar while a screen share runs. WebView2 has no setting for it, so the app
//! looks for that small top-level window of the WebView2 browser process and
//! hides it. The share itself is unaffected and stays visible in the app
//! (the status bar shows it and has a stop button).

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static WATCHING: AtomicBool = AtomicBool::new(false);

/// Starts or stops hiding the bar (the watcher thread ends when sharing stops).
#[tauri::command]
pub fn capture_bar_hide(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
    if !active || WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| {
        while ACTIVE.load(Ordering::SeqCst) {
            let n = hide_bars();
            if n > 0 {
                tracing::debug!(count = n, "Freigabe-Leiste ausgeblendet");
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        WATCHING.store(false, Ordering::SeqCst);
    });
}

/// Title marks of the bar: it names the page origin.
fn is_bar_title(title: &str) -> bool {
    let t = title.to_ascii_lowercase();
    t.contains("tauri.localhost") || t.contains("localhost:")
}

#[cfg(windows)]
fn hide_bars() -> usize {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindowAsync, SW_HIDE,
    };

    fn process_name(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return None;
            }
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len);
            CloseHandle(h);
            (ok != 0).then(|| String::from_utf16_lossy(&buf[..len as usize]).to_ascii_lowercase())
        }
    }

    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let count = &mut *(data as *mut usize);
        if IsWindowVisible(hwnd) == 0 {
            return 1;
        }
        let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        if GetWindowRect(hwnd, &mut rect) == 0 || rect.bottom - rect.top > 240 {
            return 1;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 || !is_bar_title(&String::from_utf16_lossy(&buf[..n as usize])) {
            return 1;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if process_name(pid).is_some_and(|p| p.ends_with("msedgewebview2.exe")) {
            ShowWindowAsync(hwnd, SW_HIDE);
            *count += 1;
        }
        1
    }

    let mut count = 0usize;
    unsafe {
        EnumWindows(Some(visit), &mut count as *mut usize as LPARAM);
    }
    count
}

#[cfg(not(windows))]
fn hide_bars() -> usize {
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_the_app_origin() {
        assert!(is_bar_title("tauri.localhost gibt Ihren Bildschirm frei."));
        assert!(is_bar_title("TAURI.LOCALHOST is sharing your screen."));
        assert!(is_bar_title("localhost:5173 is sharing your screen."));
        assert!(!is_bar_title("NexusTalk"));
        assert!(!is_bar_title("example.com is sharing your screen."));
    }

    #[test]
    fn scan_runs_without_a_bar() {
        assert_eq!(hide_bars(), 0);
    }
}

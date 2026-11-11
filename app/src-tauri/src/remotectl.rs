//! Remote control: inject mouse and keyboard input into the local machine while
//! the user shares their whole screen and has explicitly allowed it.
//!
//! Safety model: injection only happens while `ALLOWED` is true, which the UI sets
//! only after the host turned the feature on and either a viewer's password was
//! verified or the host confirmed the request. Stopping the share or revoking
//! clears it and releases every key and button that is still held down. On
//! non-Windows targets the commands are no-ops.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Deserialize;

/// Set by the UI when a verified remote session is active; checked on every inject.
static ALLOWED: AtomicBool = AtomicBool::new(false);

/// The shared monitor in virtual-desktop pixels (None = primary monitor).
static TARGET: Mutex<Option<Rect>> = Mutex::new(None);

/// Keys (scan code, extended) and mouse buttons the controller currently holds,
/// so they can be released when the session ends.
static HELD: Mutex<Held> = Mutex::new(Held { keys: Vec::new(), buttons: [false; 3] });

/// Most input actions accepted in one call.
const MAX_BATCH: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

struct Held {
    keys: Vec<(u16, bool)>,
    buttons: [bool; 3],
}

/// One input action from the controlling peer.
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum Cmd {
    /// Absolute mouse move, coordinates normalized 0..1 over the shared monitor.
    #[serde(rename = "m")]
    Move { x: f64, y: f64 },
    /// Relative mouse move in pixels (game mode / pointer lock).
    #[serde(rename = "r")]
    Rel { dx: f64, dy: f64 },
    /// Mouse button (0 left, 1 middle, 2 right), down or up.
    #[serde(rename = "b")]
    Button { b: u8, d: bool },
    /// Wheel in notches (positive `dy` = up, positive `dx` = right).
    #[serde(rename = "w")]
    Wheel {
        #[serde(default)]
        dy: f64,
        #[serde(default)]
        dx: f64,
    },
    /// Key, down or up: hardware scan code `s` (+ `e` for extended keys such as
    /// the arrows), or – from older clients – a Windows virtual-key code `c`.
    #[serde(rename = "k")]
    Key {
        #[serde(default)]
        s: u16,
        #[serde(default)]
        e: bool,
        #[serde(default)]
        c: u16,
        d: bool,
    },
}

/// Maps a normalized position on `target` to the 0..65535 range SendInput uses
/// for the whole virtual desktop `virt`.
pub fn to_virtual_abs(target: Rect, virt: Rect, x: f64, y: f64) -> (i32, i32) {
    let px = target.x as f64 + x.clamp(0.0, 1.0) * (target.w.max(1) - 1) as f64;
    let py = target.y as f64 + y.clamp(0.0, 1.0) * (target.h.max(1) - 1) as f64;
    let ax = (px - virt.x as f64) * 65535.0 / (virt.w.max(2) - 1) as f64;
    let ay = (py - virt.y as f64) * 65535.0 / (virt.h.max(2) - 1) as f64;
    (ax.round().clamp(0.0, 65535.0) as i32, ay.round().clamp(0.0, 65535.0) as i32)
}

/// The capture label of a shared screen is `screen:<display index>:0`.
pub fn screen_index(label: &str) -> Option<u32> {
    let rest = label.strip_prefix("screen:")?;
    rest.split(':').next()?.parse().ok()
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Turns injection on or off (called by the UI when a session is granted/ended).
/// Turning it off releases everything the controller still held down.
#[tauri::command]
pub fn remote_set_allowed(allowed: bool) {
    let was = ALLOWED.swap(allowed, Ordering::SeqCst);
    if was && !allowed {
        release_all();
    }
    if was != allowed {
        tracing::info!(allowed, "Fernsteuerung umgeschaltet");
    }
}

/// Tells the injector which monitor is being shared (`label` is the capture
/// track's label). Returns the monitor rectangle that will be used.
#[tauri::command]
pub fn remote_set_target(label: Option<String>) -> Option<(i32, i32, i32, i32)> {
    let rect = label.as_deref().and_then(screen_index).and_then(monitor_rect);
    *lock(&TARGET) = rect;
    let r = rect.or_else(primary_rect)?;
    Some((r.x, r.y, r.w, r.h))
}

/// The monitor currently used for remote control and the annotation overlay.
pub fn target_rect() -> Option<Rect> {
    (*lock(&TARGET)).or_else(primary_rect)
}

/// Applies a batch of input actions, if a session is currently allowed.
#[tauri::command]
pub fn remote_inject(cmds: Vec<Cmd>) {
    if !ALLOWED.load(Ordering::SeqCst) || cmds.len() > MAX_BATCH {
        return;
    }
    #[cfg(windows)]
    win::inject(&cmds);
    #[cfg(not(windows))]
    let _ = cmds;
}

fn release_all() {
    let (keys, buttons) = {
        let mut h = lock(&HELD);
        (std::mem::take(&mut h.keys), std::mem::replace(&mut h.buttons, [false; 3]))
    };
    #[cfg(windows)]
    win::release(&keys, buttons);
    #[cfg(not(windows))]
    let _ = (keys, buttons);
}

#[cfg(not(windows))]
fn monitor_rect(_index: u32) -> Option<Rect> {
    None
}

#[cfg(not(windows))]
fn primary_rect() -> Option<Rect> {
    None
}

#[cfg(windows)]
fn monitor_rect(index: u32) -> Option<Rect> {
    win::monitor_rect(index)
}

#[cfg(windows)]
fn primary_rect() -> Option<Rect> {
    win::primary_rect()
}

#[cfg(windows)]
mod win {
    use super::{lock, to_virtual_abs, Cmd, Rect, HELD, TARGET};
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayDevicesW, EnumDisplaySettingsExW, DEVMODEW, DISPLAY_DEVICEW, DISPLAY_DEVICE_ACTIVE, ENUM_CURRENT_SETTINGS,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
        MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, SM_CXSCREEN, SM_CXVIRTUALSCREEN, SM_CYSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    /// Virtual keys whose scan code needs the "extended" flag (arrows, navigation
    /// block, right-hand modifiers, Windows keys); used for legacy `c` commands.
    const EXTENDED_VK: [u16; 17] = [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0xA3, 0xA5, 0x2C];

    pub fn primary_rect() -> Option<Rect> {
        let (w, h) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        (w > 0 && h > 0).then_some(Rect { x: 0, y: 0, w, h })
    }

    fn virtual_rect() -> Rect {
        let (x, y, w, h) = unsafe {
            (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN))
        };
        if w > 0 && h > 0 {
            Rect { x, y, w, h }
        } else {
            primary_rect().unwrap_or(Rect { x: 0, y: 0, w: 1920, h: 1080 })
        }
    }

    /// Position and size of the display with the given `EnumDisplayDevices`
    /// index – the same numbering the screen capturer uses for its sources.
    pub fn monitor_rect(index: u32) -> Option<Rect> {
        // SAFETY: both structs are plain data, zero-initialised with their size set
        // as the API requires; the device name is passed back unchanged.
        unsafe {
            let mut dev: DISPLAY_DEVICEW = std::mem::zeroed();
            dev.cb = std::mem::size_of::<DISPLAY_DEVICEW>() as u32;
            if EnumDisplayDevicesW(std::ptr::null(), index, &mut dev, 0) == 0 || dev.StateFlags & DISPLAY_DEVICE_ACTIVE == 0 {
                return None;
            }
            let mut mode: DEVMODEW = std::mem::zeroed();
            mode.dmSize = std::mem::size_of::<DEVMODEW>() as u16;
            if EnumDisplaySettingsExW(dev.DeviceName.as_ptr(), ENUM_CURRENT_SETTINGS, &mut mode, 0) == 0 {
                return None;
            }
            let pos = mode.Anonymous1.Anonymous2.dmPosition;
            let (w, h) = (mode.dmPelsWidth as i32, mode.dmPelsHeight as i32);
            (w > 0 && h > 0).then_some(Rect { x: pos.x, y: pos.y, w, h })
        }
    }

    fn mouse(dx: i32, dy: i32, data: i32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn key(scan: u16, ext: bool, down: bool) -> INPUT {
        let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
        if ext {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        if !down {
            flags |= KEYEVENTF_KEYUP;
        }
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    fn button_flag(b: u8, d: bool) -> Option<MOUSE_EVENT_FLAGS> {
        Some(match (b, d) {
            (0, true) => MOUSEEVENTF_LEFTDOWN,
            (0, false) => MOUSEEVENTF_LEFTUP,
            (1, true) => MOUSEEVENTF_MIDDLEDOWN,
            (1, false) => MOUSEEVENTF_MIDDLEUP,
            (2, true) => MOUSEEVENTF_RIGHTDOWN,
            (2, false) => MOUSEEVENTF_RIGHTUP,
            _ => return None,
        })
    }

    fn send(inputs: &[INPUT]) {
        if !inputs.is_empty() {
            // SAFETY: `inputs` is a valid slice of fully initialised INPUT structs.
            unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
        }
    }

    pub fn inject(cmds: &[Cmd]) {
        let target = (*lock(&TARGET)).or_else(primary_rect).unwrap_or(Rect { x: 0, y: 0, w: 1920, h: 1080 });
        let virt = virtual_rect();
        let mut inputs: Vec<INPUT> = Vec::with_capacity(cmds.len());
        let mut held = lock(&HELD);
        for c in cmds {
            match *c {
                Cmd::Move { x, y } => {
                    let (ax, ay) = to_virtual_abs(target, virt, x, y);
                    inputs.push(mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
                }
                Cmd::Rel { dx, dy } => {
                    let (dx, dy) = (dx.round().clamp(-2000.0, 2000.0) as i32, dy.round().clamp(-2000.0, 2000.0) as i32);
                    if dx != 0 || dy != 0 {
                        inputs.push(mouse(dx, dy, 0, MOUSEEVENTF_MOVE));
                    }
                }
                Cmd::Button { b, d } => {
                    if let Some(flag) = button_flag(b, d) {
                        held.buttons[b as usize] = d;
                        inputs.push(mouse(0, 0, 0, flag));
                    }
                }
                Cmd::Wheel { dy, dx } => {
                    let v = (dy.clamp(-20.0, 20.0) * 120.0).round() as i32;
                    if v != 0 {
                        inputs.push(mouse(0, 0, v, MOUSEEVENTF_WHEEL));
                    }
                    let hz = (dx.clamp(-20.0, 20.0) * 120.0).round() as i32;
                    if hz != 0 {
                        inputs.push(mouse(0, 0, hz, MOUSEEVENTF_HWHEEL));
                    }
                }
                Cmd::Key { s, e, c, d } => {
                    let (scan, ext) = if s != 0 {
                        (s, e)
                    } else if c != 0 {
                        // SAFETY: plain lookup in the active keyboard layout.
                        (unsafe { MapVirtualKeyW(c as u32, 0) } as u16, EXTENDED_VK.contains(&c))
                    } else {
                        continue;
                    };
                    if scan == 0 || scan > 0x7F {
                        continue;
                    }
                    held.keys.retain(|k| *k != (scan, ext));
                    if d {
                        held.keys.push((scan, ext));
                    }
                    inputs.push(key(scan, ext, d));
                }
            }
        }
        drop(held);
        send(&inputs);
    }

    pub fn release(keys: &[(u16, bool)], buttons: [bool; 3]) {
        let mut inputs: Vec<INPUT> = keys.iter().map(|&(s, e)| key(s, e, false)).collect();
        for (b, down) in buttons.iter().enumerate() {
            if *down {
                if let Some(flag) = button_flag(b as u8, false) {
                    inputs.push(mouse(0, 0, 0, flag));
                }
            }
        }
        send(&inputs);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_gate_blocks_until_enabled() {
        remote_set_allowed(false);
        // No panic and nothing injected when disabled.
        remote_inject(vec![Cmd::Move { x: 0.5, y: 0.5 }]);
        assert!(!ALLOWED.load(Ordering::SeqCst));
    }

    #[test]
    fn parses_input_commands() {
        let cmds: Vec<Cmd> = serde_json::from_str(
            r#"[{"t":"m","x":0.5,"y":0.25},{"t":"b","b":0,"d":true},{"t":"w","dy":-1.0},{"t":"k","c":65,"d":true},
                {"t":"k","s":72,"e":true,"d":false},{"t":"r","dx":4,"dy":-2},{"t":"w","dx":1}]"#,
        )
        .unwrap();
        assert_eq!(cmds.len(), 7);
        assert!(matches!(cmds[0], Cmd::Move { .. }));
        assert!(matches!(cmds[3], Cmd::Key { c: 65, s: 0, d: true, .. }));
        assert!(matches!(cmds[4], Cmd::Key { s: 72, e: true, d: false, .. }));
        assert!(matches!(cmds[5], Cmd::Rel { .. }));
    }

    #[test]
    fn maps_to_the_shared_monitor_on_a_multi_monitor_desktop() {
        // Two 1920x1080 monitors side by side, the second one is shared.
        let virt = Rect { x: 0, y: 0, w: 3840, h: 1080 };
        let second = Rect { x: 1920, y: 0, w: 1920, h: 1080 };
        let (x0, y0) = to_virtual_abs(second, virt, 0.0, 0.0);
        let (x1, y1) = to_virtual_abs(second, virt, 1.0, 1.0);
        assert_eq!((x0, y0), (32776, 0)); // pixel 1920 of 3840
        assert_eq!((x1, y1), (65535, 65535));
        // A monitor left of the primary one has negative coordinates.
        let virt = Rect { x: -1280, y: 0, w: 3200, h: 1080 };
        let left = Rect { x: -1280, y: 0, w: 1280, h: 1024 };
        assert_eq!(to_virtual_abs(left, virt, 0.0, 0.0), (0, 0));
        let (cx, _) = to_virtual_abs(left, virt, 1.0, 0.0);
        assert_eq!(cx, ((1279.0_f64 * 65535.0) / 3199.0).round() as i32);
        // Out-of-range input is clamped onto the monitor.
        assert_eq!(to_virtual_abs(second, virt, -3.0, 9.0), to_virtual_abs(second, virt, 0.0, 1.0));
    }

    /// Moves the real mouse pointer for a moment (and puts it back), so it only
    /// runs on request: `cargo test -p nexustalk real_cursor -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn real_cursor_lands_where_the_controller_points() {
        use windows_sys::Win32::Foundation::POINT;
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, SetCursorPos};
        let mut before = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut before) };
        let target = primary_rect().expect("primary monitor");
        *lock(&TARGET) = None;
        remote_set_allowed(true);
        let mut worst = 0;
        for (x, y) in [(0.5, 0.5), (0.25, 0.75), (0.9, 0.1)] {
            remote_inject(vec![Cmd::Move { x, y }]);
            std::thread::sleep(std::time::Duration::from_millis(60));
            let mut now = POINT { x: 0, y: 0 };
            unsafe { GetCursorPos(&mut now) };
            let want = (target.x + (x * (target.w - 1) as f64).round() as i32, target.y + (y * (target.h - 1) as f64).round() as i32);
            worst = worst.max((now.x - want.0).abs()).max((now.y - want.1).abs());
        }
        // A relative move shifts the pointer in the right direction.
        let mut a = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut a) };
        remote_inject(vec![Cmd::Rel { dx: -40.0, dy: 30.0 }]);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut b = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut b) };
        remote_set_allowed(false);
        // Once the session is over nothing moves any more.
        remote_inject(vec![Cmd::Move { x: 0.1, y: 0.1 }]);
        std::thread::sleep(std::time::Duration::from_millis(60));
        let mut c = POINT { x: 0, y: 0 };
        unsafe { GetCursorPos(&mut c) };
        unsafe { SetCursorPos(before.x, before.y) };
        assert!(worst <= 2, "absolute moves are off by {worst} px");
        assert!(b.x < a.x && b.y > a.y, "relative move went the wrong way: {:?} → {:?}", (a.x, a.y), (b.x, b.y));
        assert_eq!((c.x, c.y), (b.x, b.y), "input was injected after the session ended");
    }

    #[test]
    fn reads_the_display_index_from_the_capture_label() {
        assert_eq!(screen_index("screen:0:0"), Some(0));
        assert_eq!(screen_index("screen:2:0"), Some(2));
        assert_eq!(screen_index("window:1234:0"), None);
        assert_eq!(screen_index("Bildschirm 1"), None);
    }
}

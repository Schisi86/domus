//! Remote control: inject mouse, keyboard and (mapped) controller input into the
//! local machine while the user shares their screen and has explicitly allowed it.
//!
//! Safety model: injection only happens while `ALLOWED` is true, which the UI sets
//! only after the host turned the feature on, set a password, and a viewer's
//! password was verified. Stopping the share or revoking clears it. On non-Windows
//! targets the commands are no-ops.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

/// Set by the UI when a verified remote session is active; checked on every inject.
static ALLOWED: AtomicBool = AtomicBool::new(false);

/// One input action from the controlling peer.
#[derive(Debug, Deserialize)]
#[serde(tag = "t")]
pub enum Cmd {
    /// Absolute mouse move, coordinates normalized 0..1 over the primary screen.
    #[serde(rename = "m")]
    Move { x: f64, y: f64 },
    /// Mouse button (0 left, 1 middle, 2 right), down or up.
    #[serde(rename = "b")]
    Button { b: u8, d: bool },
    /// Wheel; `dy` in notches (positive = up).
    #[serde(rename = "w")]
    Wheel { dy: f64 },
    /// Key by Windows virtual-key code, down or up.
    #[serde(rename = "k")]
    Key { c: u16, d: bool },
}

/// Turns injection on or off (called by the UI when a session is granted/ended).
#[tauri::command]
pub fn remote_set_allowed(allowed: bool) {
    ALLOWED.store(allowed, Ordering::SeqCst);
    tracing::info!(allowed, "Fernsteuerung umgeschaltet");
}

/// Applies a batch of input actions, if a session is currently allowed.
#[tauri::command]
pub fn remote_inject(cmds: Vec<Cmd>) {
    if !ALLOWED.load(Ordering::SeqCst) {
        return;
    }
    #[cfg(windows)]
    inject(&cmds);
    #[cfg(not(windows))]
    let _ = cmds;
}

#[cfg(windows)]
fn inject(cmds: &[Cmd]) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
        MapVirtualKeyW, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
        MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL,
        MOUSE_EVENT_FLAGS,
    };

    let mut inputs: Vec<INPUT> = Vec::with_capacity(cmds.len());
    for c in cmds {
        match *c {
            Cmd::Move { x, y } => {
                // Absolute coordinates are 0..65535 across the whole virtual desktop.
                let ax = (x.clamp(0.0, 1.0) * 65535.0).round() as i32;
                let ay = (y.clamp(0.0, 1.0) * 65535.0).round() as i32;
                inputs.push(mouse(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
            }
            Cmd::Button { b, d } => {
                let flag: MOUSE_EVENT_FLAGS = match (b, d) {
                    (0, true) => MOUSEEVENTF_LEFTDOWN,
                    (0, false) => MOUSEEVENTF_LEFTUP,
                    (1, true) => MOUSEEVENTF_MIDDLEDOWN,
                    (1, false) => MOUSEEVENTF_MIDDLEUP,
                    (2, true) => MOUSEEVENTF_RIGHTDOWN,
                    (2, false) => MOUSEEVENTF_RIGHTUP,
                    _ => continue,
                };
                inputs.push(mouse(0, 0, 0, flag));
            }
            Cmd::Wheel { dy } => {
                let delta = (dy * 120.0).round() as i32;
                inputs.push(mouse(0, 0, delta, MOUSEEVENTF_WHEEL));
            }
            Cmd::Key { c, d } => {
                // Send by hardware scan code so layouts and games behave normally.
                let scan = unsafe { MapVirtualKeyW(c as u32, 0) } as u16; // 0 = MAPVK_VK_TO_VSC
                let mut flags: KEYBD_EVENT_FLAGS = KEYEVENTF_SCANCODE;
                if !d {
                    flags |= KEYEVENTF_KEYUP;
                }
                inputs.push(INPUT {
                    r#type: INPUT_KEYBOARD,
                    Anonymous: INPUT_0 {
                        ki: KEYBDINPUT { wVk: 0, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                    },
                });
            }
        }
    }
    if !inputs.is_empty() {
        unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
    }
}

#[cfg(windows)]
fn mouse(dx: i32, dy: i32, data: i32, flags: windows_sys::Win32::UI::Input::KeyboardAndMouse::MOUSE_EVENT_FLAGS) -> windows_sys::Win32::UI::Input::KeyboardAndMouse::INPUT {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{INPUT, INPUT_0, INPUT_MOUSE, MOUSEINPUT};
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
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
        remote_set_allowed(true);
        assert!(ALLOWED.load(Ordering::SeqCst));
        remote_set_allowed(false);
        assert!(!ALLOWED.load(Ordering::SeqCst));
    }

    #[test]
    fn parses_input_commands() {
        let cmds: Vec<Cmd> = serde_json::from_str(r#"[{"t":"m","x":0.5,"y":0.25},{"t":"b","b":0,"d":true},{"t":"w","dy":-1.0},{"t":"k","c":65,"d":true}]"#).unwrap();
        assert_eq!(cmds.len(), 4);
        assert!(matches!(cmds[0], Cmd::Move { .. }));
        assert!(matches!(cmds[3], Cmd::Key { c: 65, d: true }));
    }
}

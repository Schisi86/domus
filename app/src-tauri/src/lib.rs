//! NexusTalk desktop shell (Tauri 2).
//!
//! The UI lives in `app/src` (Preact). This crate provides:
//! * `net`   – pinned-TLS networking for the UI (HTTP, WebSocket, files)
//! * `host`  – the embedded servers ("Servermodus", several at once)
//! * `store` – client configuration with DPAPI-encrypted session tokens
//! * tray icon, single instance, autostart, media permission handling

mod capture_bar;
mod host;
mod net;
mod reach;
mod store;
mod tunnel;

use std::path::PathBuf;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

pub fn app_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("NexusTalk")
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    data_dir: String,
    log_dir: String,
    background: bool,
    /// Windows account name, used to prefill the owner name of a new server.
    user_name: String,
}

struct Flags {
    background: bool,
}

/// Tray menu entries, kept to relabel them when the UI language changes.
struct TrayItems(std::sync::Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>>);

#[tauri::command]
fn set_tray_labels(items: State<'_, TrayItems>, open: String, quit: String) {
    if let Some((o, q)) = items.0.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
        let _ = o.set_text(open);
        let _ = q.set_text(quit);
    }
}

#[tauri::command]
fn app_info(flags: State<'_, Flags>) -> AppInfo {
    let dir = app_dir();
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: dir.display().to_string(),
        log_dir: dir.join("logs").display().to_string(),
        background: flags.background,
        user_name: std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default(),
    }
}

/// Lets the UI write errors into the rotating log file.
#[tauri::command]
fn client_log(level: String, message: String) {
    let message: String = message.chars().take(2000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "ui", "{message}"),
        "warn" => tracing::warn!(target: "ui", "{message}"),
        _ => tracing::info!(target: "ui", "{message}"),
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let dir = app_dir();
    // Only folders below our own data directory may be opened.
    if !p.starts_with(&dir) {
        return Err("Pfad nicht erlaubt".into());
    }
    let _ = std::fs::create_dir_all(&p);
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn quit_app(app: AppHandle) {
    shutdown_and_exit(&app).await;
}

async fn shutdown_and_exit(app: &AppHandle) {
    app.state::<host::HostManager>().stop_all().await;
    app.exit(0);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "NexusTalk öffnen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    *app.state::<TrayItems>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some((open.clone(), quit.clone()));
    let mut tb = TrayIconBuilder::with_id("main")
        .tooltip("NexusTalk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => show_main(app),
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move { shutdown_and_exit(&app).await });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tb = tb.icon(icon.clone());
    }
    tb.build(app)?;
    Ok(())
}

pub fn run() {
    let background = std::env::args().any(|a| a == "--background");
    let dir = app_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _log_guard = nexus_server::logbuf::init(Some(&dir.join("logs")), "nexustalk", "info", 7, cfg!(debug_assertions));
    tracing::info!(version = env!("CARGO_PKG_VERSION"), background, "NexusTalk starting");

    let store = store::ConfigStore { path: dir.join("client.json") };
    let (initial, _) = store.load();

    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(net::NetState::default())
        .manage(host::HostManager::load(dir.clone(), initial.host_autostart))
        .manage(store)
        .manage(Flags { background })
        .manage(TrayItems(std::sync::Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            app_info,
            client_log,
            open_folder,
            quit_app,
            set_tray_labels,
            net::net_http,
            net::net_bytes,
            net::net_upload,
            net::net_download,
            net::ws_open,
            net::ws_send,
            net::ws_close,
            host::host_list,
            host::host_status,
            host::host_create,
            host::host_remove,
            host::host_rename,
            host::host_set_autostart,
            host::host_set_relay,
            capture_bar::capture_bar_hide,
            host::host_config,
            host::host_config_save,
            host::host_config_reset,
            host::host_start,
            host::host_stop,
            host::host_restart,
            host::host_setup_done,
            reach::firewall_check,
            reach::firewall_open,
            store::config_load,
            store::config_save,
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("NexusTalk")
                .inner_size(1180.0, 760.0)
                .min_inner_size(760.0, 480.0)
                // The UI draws its own title bar in the colours of the active design.
                .decorations(false)
                .visible(!background)
                .on_permission_request(|_, kind| match kind {
                    // Requested only after an explicit user action (joining voice,
                    // turning on the camera); the UI always shows when they are live.
                    PermissionKind::Microphone | PermissionKind::Camera => PermissionResponse::Allow,
                    PermissionKind::Notifications => PermissionResponse::Allow,
                    _ => PermissionResponse::Default,
                })
                .build()?;
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let hosts = handle.state::<host::HostManager>();
                for id in hosts.autostart_ids() {
                    if let Err(e) = async { hosts.get(&id)?.start().await }.await {
                        tracing::error!(host = %id, "Server-Autostart fehlgeschlagen: {e}");
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let host_running = app.state::<host::HostManager>().any_running();
                let to_tray = app.state::<store::ConfigStore>().load().0.minimize_to_tray;
                if host_running || to_tray {
                    // Keep running in the tray (hosted servers must stay reachable).
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    let app = app.clone();
                    api.prevent_close();
                    tauri::async_runtime::spawn(async move { shutdown_and_exit(&app).await });
                }
            }
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        tracing::error!(error = %e, "NexusTalk terminated with error");
        eprintln!("NexusTalk konnte nicht gestartet werden: {e}");
    }
}

//! Domus desktop shell (Tauri 2). Formerly NexUs and NexusTalk – the data folder
//! (%APPDATA%\NexusTalk) and the app identifier keep the old name, so updates
//! carry over servers, accounts and settings.
//!
//! The UI lives in `app/src` (Preact). This crate provides:
//! * `net`   – pinned-TLS networking for the UI (HTTP, WebSocket, files)
//! * `host`  – the embedded servers ("Servermodus", several at once)
//! * `store` – client configuration with DPAPI-encrypted session tokens
//! * tray icon, single instance, autostart, media permission handling
//!
//! On Android the same crate builds the phone app. It can host servers too
//! (kept alive by a foreground service); tray, global keys, remote control and
//! the desktop overlay are desktop-only.

#[cfg(mobile)]
mod android;
#[cfg(desktop)]
mod capture_bar;
#[cfg(not(target_os = "ios"))]
mod host;
#[cfg(desktop)]
mod ink;
mod local;
mod net;
#[cfg(not(target_os = "ios"))]
mod reach;
#[cfg(desktop)]
mod remotectl;
mod store;
#[cfg(not(target_os = "ios"))]
mod tunnel;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde::Serialize;
#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
#[cfg(desktop)]
use tauri::webview::{PermissionKind, PermissionResponse};
#[cfg(desktop)]
use tauri::WindowEvent;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Data folder of the phone app (set at start-up from the OS).
static APP_DIR: OnceLock<PathBuf> = OnceLock::new();

pub fn app_dir() -> PathBuf {
    if let Some(d) = APP_DIR.get() {
        return d.clone();
    }
    // macOS: the usual place for app data (~/Library/Application Support/Domus).
    #[cfg(target_os = "macos")]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home).join("Library/Application Support/Domus");
    }
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
#[cfg(desktop)]
struct TrayItems(std::sync::Mutex<Option<(MenuItem<tauri::Wry>, MenuItem<tauri::Wry>)>>);

#[cfg(desktop)]
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
    #[cfg(target_os = "macos")]
    std::process::Command::new("open").arg(&p).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn quit_app(app: AppHandle) {
    shutdown_and_exit(&app).await;
}

async fn shutdown_and_exit(app: &AppHandle) {
    #[cfg(not(target_os = "ios"))]
    if let Some(h) = app.try_state::<host::HostManager>() {
        h.stop_all().await;
    }
    app.exit(0);
}

#[cfg(desktop)]
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Domus öffnen", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &PredefinedMenuItem::separator(app)?, &quit])?;
    *app.state::<TrayItems>().0.lock().unwrap_or_else(|p| p.into_inner()) = Some((open.clone(), quit.clone()));
    let mut tb = TrayIconBuilder::with_id("main")
        .tooltip("Domus")
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

/// Commands shared by the phone apps.
#[cfg(mobile)]
macro_rules! mobile_commands {
    ($($extra:path),* $(,)?) => {
        tauri::generate_handler![
            app_info,
            client_log,
            open_folder,
            quit_app,
            net::net_http,
            net::net_bytes,
            net::net_upload,
            net::net_download,
            net::ws_open,
            net::ws_send,
            net::ws_close,
            local::secret_get,
            local::secret_set,
            local::file_save_begin,
            local::file_save_chunk,
            local::file_save_end,
            store::config_load,
            store::config_save,
            $($extra),*
        ]
    };
}

#[cfg(mobile)]
#[tauri::mobile_entry_point]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(android::init())
        .manage(net::NetState::default())
        .manage(Flags { background: false });
    // Android hosts servers (kept alive by a foreground service); iOS stops
    // apps in the background, so the iOS app is a client only.
    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(mobile_commands![
        host::host_list,
        host::host_status,
        host::host_create,
        host::host_remove,
        host::host_rename,
        host::host_set_autostart,
        host::host_set_relay,
        host::host_config,
        host::host_config_save,
        host::host_config_reset,
        host::host_start,
        host::host_stop,
        host::host_restart,
        host::host_setup_done,
        reach::firewall_check,
        reach::firewall_open,
    ]);
    #[cfg(target_os = "ios")]
    let builder = builder.invoke_handler(mobile_commands![]);
    let result = builder
        .setup(|app| {
            // The private app folder (only Domus can read it).
            let dir = app.path().app_data_dir()?;
            let _ = std::fs::create_dir_all(&dir);
            let _ = APP_DIR.set(dir.clone());
            init_mobile_log(&dir.join("logs"));
            tracing::info!(version = env!("CARGO_PKG_VERSION"), os = std::env::consts::OS, "Domus (mobile) starting");
            let store = store::ConfigStore { path: dir.join("client.json") };
            let (initial, _) = store.load();
            app.manage(store);
            #[cfg(target_os = "android")]
            app.manage(host::HostManager::load(dir.clone(), initial.host_autostart));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into())).build()?;
            #[cfg(target_os = "android")]
            if initial.hosts_autostart {
                spawn_host_autostart(app.handle().clone());
            }
            #[cfg(target_os = "ios")]
            let _ = initial;
            Ok(())
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        tracing::error!(error = %e, "Domus terminated with error");
    }
}

/// Android: the server crate's log setup (also feeds the server log view).
#[cfg(target_os = "android")]
fn init_mobile_log(dir: &std::path::Path) {
    std::mem::forget(nexus_server::logbuf::init(Some(dir), "domus", "info", 5, false));
}

/// iOS: daily log files in the app folder (the server crate is not built there).
#[cfg(target_os = "ios")]
fn init_mobile_log(dir: &std::path::Path) {
    use tracing_subscriber::prelude::*;
    let _ = std::fs::create_dir_all(dir);
    let Ok(appender) = tracing_appender::rolling::Builder::new()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("domus")
        .filename_suffix("log")
        .max_log_files(5)
        .build(dir)
    else {
        return;
    };
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new("info"))
        .with(tracing_subscriber::fmt::layer().with_writer(std::sync::Mutex::new(appender)).with_ansi(false))
        .try_init();
}

#[cfg(not(target_os = "ios"))]
/// Starts the hosted servers marked for autostart; retries a few times because
/// the network may not be ready yet right after start-up.
fn spawn_host_autostart(handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let hosts = handle.state::<host::HostManager>();
        let mut pending = hosts.autostart_ids();
        for wait in [0u64, 3, 8, 20] {
            if pending.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
            let mut failed = Vec::new();
            for id in pending {
                match async { hosts.get(&id)?.start().await }.await {
                    Ok(_) => tracing::info!(host = %id, "Server automatisch gestartet"),
                    Err(e) => {
                        tracing::error!(host = %id, "Server-Autostart fehlgeschlagen: {e}");
                        failed.push(id);
                    }
                }
            }
            pending = failed;
        }
    });
}

#[cfg(desktop)]
pub fn run() {
    let background = std::env::args().any(|a| a == "--background");
    let dir = app_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _log_guard = nexus_server::logbuf::init(Some(&dir.join("logs")), "nexustalk", "info", 7, cfg!(debug_assertions));
    tracing::info!(version = env!("CARGO_PKG_VERSION"), background, "Domus starting");

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
            remotectl::remote_set_allowed,
            remotectl::remote_set_target,
            remotectl::remote_inject,
            ink::ink_overlay,
            local::secret_get,
            local::secret_set,
            local::file_save_begin,
            local::file_save_chunk,
            local::file_save_end,
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
            #[cfg(target_os = "macos")]
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            #[cfg(not(target_os = "macos"))]
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()));
            main
                .title("Domus")
                .inner_size(1180.0, 760.0)
                .min_inner_size(760.0, 480.0)
                // Windows: the UI draws its own title bar in the colours of the
                // active design. macOS keeps the native traffic lights on top of it.
                .decorations(cfg!(target_os = "macos"))
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
            if initial.hosts_autostart {
                spawn_host_autostart(app.handle().clone());
            } else {
                tracing::info!("Server-Autostart ist in den Einstellungen abgeschaltet");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Only the main window decides between tray and exit; helper windows
            // (the annotation overlay) simply close.
            if window.label() != "main" {
                return;
            }
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
        tracing::error!(error = %e, "Domus terminated with error");
        eprintln!("Domus konnte nicht gestartet werden: {e}");
    }
}

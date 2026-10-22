//! "Servermodus": runs the NexusTalk server inside the desktop app.
//!
//! A supervisor task owns the running server, restarts it when an admin asks
//! for it (e.g. after a backup restore) and stops it on request. The server
//! keeps running while the window is hidden in the tray.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use nexus_server::config::Config;
use serde::Serialize;
use tauri::State;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Default, Serialize)]
pub struct HostStatus {
    pub running: bool,
    pub address: Option<String>,
    pub fingerprint: Option<String>,
    pub setup_code: Option<String>,
    pub error: Option<String>,
    pub data_dir: String,
    pub exposed: bool,
    pub lan_ip: Option<String>,
}

pub struct HostState {
    pub data_dir: PathBuf,
    status: Arc<Mutex<HostStatus>>,
    control: tokio::sync::Mutex<Option<(oneshot::Sender<()>, tauri::async_runtime::JoinHandle<()>)>>,
}

impl HostState {
    pub fn new(data_dir: PathBuf) -> Self {
        let status = HostStatus { data_dir: data_dir.display().to_string(), ..Default::default() };
        Self { data_dir, status: Arc::new(Mutex::new(status)), control: tokio::sync::Mutex::new(None) }
    }

    fn config_path(&self) -> PathBuf {
        self.data_dir.join("server.toml")
    }

    pub fn load_config(&self) -> Result<Config, String> {
        Config::load(&self.config_path()).map_err(|e| e.to_string())
    }

    pub fn status(&self) -> HostStatus {
        let mut s = self.status.lock().unwrap_or_else(|p| p.into_inner()).clone();
        s.lan_ip = nexus_server::media::primary_local_ip().map(|i| i.to_string());
        s
    }

    pub fn is_running(&self) -> bool {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).running
    }

    pub async fn start(&self) -> Result<HostStatus, String> {
        let mut ctl = self.control.lock().await;
        if ctl.is_some() && self.is_running() {
            return Ok(self.status());
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        let cfg = self.load_config()?;
        if !self.config_path().exists() {
            cfg.save(&self.config_path()).map_err(|e| e.to_string())?;
        }
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let (first_tx, first_rx) = oneshot::channel::<Result<(), String>>();
        let status = self.status.clone();
        let data_dir = self.data_dir.clone();
        let cfg_path = self.config_path();
        let handle = tauri::async_runtime::spawn(async move {
            let mut first = Some(first_tx);
            let mut cfg = cfg;
            loop {
                let started = nexus_server::start(cfg.clone(), &data_dir).await;
                let server = match started {
                    Ok(s) => s,
                    Err(e) => {
                        let msg = e.to_string();
                        tracing::error!("Server konnte nicht gestartet werden: {msg}");
                        {
                            let mut st = status.lock().unwrap_or_else(|p| p.into_inner());
                            st.running = false;
                            st.error = Some(msg.clone());
                        }
                        if let Some(f) = first.take() {
                            let _ = f.send(Err(msg));
                        }
                        return;
                    }
                };
                {
                    let mut st = status.lock().unwrap_or_else(|p| p.into_inner());
                    st.running = true;
                    st.error = None;
                    st.address = Some(server.local_addr.to_string());
                    st.fingerprint = server.tls_fingerprint.clone();
                    st.setup_code = server.setup_code.clone();
                    st.exposed = cfg.is_exposed();
                }
                if let Some(f) = first.take() {
                    let _ = f.send(Ok(()));
                }
                let stop = tokio::select! {
                    _ = &mut stop_rx => true,
                    _ = server.restart_requested() => false,
                };
                server.shutdown().await;
                if stop {
                    let mut st = status.lock().unwrap_or_else(|p| p.into_inner());
                    st.running = false;
                    st.address = None;
                    st.setup_code = None;
                    return;
                }
                // Restart: re-read the configuration in case it was changed.
                if let Ok(c) = Config::load(&cfg_path) {
                    cfg = c;
                }
            }
        });
        match first_rx.await {
            Ok(Ok(())) => {
                *ctl = Some((stop_tx, handle));
                Ok(self.status())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Server-Task wurde unerwartet beendet".into()),
        }
    }

    pub async fn stop(&self) {
        let mut ctl = self.control.lock().await;
        if let Some((tx, handle)) = ctl.take() {
            let _ = tx.send(());
            let _ = handle.await;
        }
        let mut st = self.status.lock().unwrap_or_else(|p| p.into_inner());
        st.running = false;
        st.address = None;
    }

    /// Refreshes the setup code shown in the UI (it disappears once the owner exists).
    pub fn clear_setup_code(&self) {
        self.status.lock().unwrap_or_else(|p| p.into_inner()).setup_code = None;
    }
}

#[tauri::command]
pub fn host_status(host: State<'_, HostState>) -> HostStatus {
    host.status()
}

#[tauri::command]
pub fn host_config(host: State<'_, HostState>) -> Result<Config, String> {
    host.load_config()
}

#[tauri::command]
pub fn host_config_save(host: State<'_, HostState>, config: Config) -> Result<(), String> {
    std::fs::create_dir_all(&host.data_dir).map_err(|e| e.to_string())?;
    config.save(&host.config_path()).map_err(|e| e.to_string())
}

/// Replaces a damaged configuration file with defaults (keeps a copy).
#[tauri::command]
pub fn host_config_reset(host: State<'_, HostState>) -> Result<(), String> {
    let p = host.config_path();
    if p.exists() {
        let _ = std::fs::rename(&p, p.with_extension("toml.broken"));
    }
    Config::default().save(&p).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn host_start(host: State<'_, HostState>) -> Result<HostStatus, String> {
    host.start().await
}

#[tauri::command]
pub async fn host_stop(host: State<'_, HostState>) -> Result<HostStatus, String> {
    host.stop().await;
    Ok(host.status())
}

#[tauri::command]
pub async fn host_restart(host: State<'_, HostState>) -> Result<HostStatus, String> {
    host.stop().await;
    host.start().await
}

#[tauri::command]
pub fn host_setup_done(host: State<'_, HostState>) {
    host.clear_setup_code();
}

//! NexusTalk server library.
//!
//! The same code runs inside the desktop app ("Servermodus") and as the
//! headless `nexustalk-server` binary. [`start`] binds the listeners and
//! returns a [`RunningServer`] handle that can be shut down or restarted.
//!
//! Layout:
//! * `http`  – REST endpoints (auth, files, avatars) and the WebSocket upgrade
//! * `ws`    – per-connection loop and op dispatch; ops live in `ops_*`
//! * `hub`   – live connections, event fan-out, presence
//! * `store` – SQL queries; `db` – connection + migrations
//! * `perms` – permission model, evaluated from an in-memory cache
//! * `media` – STUN responder / TURN relay for WebRTC NAT traversal

pub mod auth;
pub mod config;
pub mod db;
pub mod error;
pub mod files;
pub mod http;
pub mod hub;
pub mod logbuf;
pub mod maintenance;
pub mod media;
pub mod ops_admin;
pub mod ops_chat;
pub mod ops_social;
pub mod ops_voice;
pub mod perms;
pub mod ratelimit;
pub mod store;
pub mod tls;
pub mod util;
pub mod ws;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::config::Config;
use crate::db::Db;
use crate::error::ApiResult;
use crate::hub::Hub;
use crate::perms::PermCache;
use crate::store::ServerSettings;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const PROTOCOL: u32 = 1;

pub struct AppState {
    pub cfg: Config,
    pub data_dir: PathBuf,
    pub db: Db,
    pub settings: RwLock<ServerSettings>,
    pub perms: RwLock<PermCache>,
    pub hub: Hub,
    pub voice: Mutex<ops_voice::VoiceRegistry>,
    pub auth_limiter: ratelimit::IpLimiter,
    /// Uploads (attachments, avatars, icon) per IP.
    pub upload_limiter: ratelimit::IpLimiter,
    pub started: Instant,
    pub turn_secret: String,
    pub fingerprint: Option<String>,
    pub control: tokio::sync::watch::Sender<Control>,
    cpu_sample: Mutex<Option<(Instant, Duration)>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Run,
    Restart,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub version: &'static str,
    pub uptime_secs: u64,
    pub connections: usize,
    pub online_users: usize,
    pub voice_participants: usize,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f64>,
    pub db_bytes: u64,
    pub uploads_bytes: i64,
    pub messages: i64,
}

impl AppState {
    pub fn settings(&self) -> ServerSettings {
        self.settings.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn perms(&self) -> std::sync::RwLockReadGuard<'_, PermCache> {
        self.perms.read().unwrap_or_else(|p| p.into_inner())
    }

    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }

    pub fn backups_dir(&self) -> PathBuf {
        self.data_dir.join("backups")
    }

    /// Reloads the permission snapshot after roles/channels/assignments changed.
    pub async fn reload_perms(&self) -> ApiResult<()> {
        let pc = self.db.call(|c| store::load_perm_cache(c)).await?;
        *self.perms.write().unwrap_or_else(|p| p.into_inner()) = pc;
        Ok(())
    }

    /// Sends an event to everyone who can see the channel.
    pub fn broadcast_channel(&self, channel_id: i64, msg: &Arc<str>) {
        let pc = self.perms();
        self.hub.broadcast(msg, |uid| pc.has_in(uid, channel_id, perms::VIEW_CHANNEL));
    }

    /// Pushes a fresh channel/role structure to every online user.
    pub async fn sync_guild(&self) -> ApiResult<()> {
        let (roles, cats, chans) =
            self.db.call(|c| Ok((store::list_roles(c)?, store::list_categories(c)?, store::list_channels(c)?))).await?;
        let pc = self.perms();
        for uid in self.hub.online_users() {
            let ev = hub::event("guild.sync", &ws::guild_snapshot(&pc, uid, &roles, &cats, &chans));
            self.hub.send_user(uid, &ev);
        }
        Ok(())
    }

    pub async fn stats(&self) -> ApiResult<Stats> {
        let db_path = self.data_dir.join("nexus.db");
        let (uploads, messages) = self.db.call(|c| Ok((store::storage_used(c)?, store::count_messages(c)?))).await?;
        let db_bytes = ["", "-wal"]
            .iter()
            .filter_map(|s| std::fs::metadata(format!("{}{}", db_path.display(), s)).ok())
            .map(|m| m.len())
            .sum();
        let cpu_percent = {
            let now = Instant::now();
            let cpu = cpu_time::ProcessTime::try_now().ok().map(|t| t.as_duration());
            let mut s = self.cpu_sample.lock().unwrap_or_else(|p| p.into_inner());
            let pct = match (*s, cpu) {
                (Some((t0, c0)), Some(c1)) if now > t0 => {
                    let wall = now.duration_since(t0).as_secs_f64();
                    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1) as f64;
                    Some(((c1.saturating_sub(c0)).as_secs_f64() / wall / cores * 100.0 * 10.0).round() / 10.0)
                }
                _ => None,
            };
            if let Some(c) = cpu {
                *s = Some((now, c));
            }
            pct
        };
        Ok(Stats {
            version: VERSION,
            uptime_secs: self.started.elapsed().as_secs(),
            connections: self.hub.total(),
            online_users: self.hub.online_users().len(),
            voice_participants: self.voice.lock().unwrap_or_else(|p| p.into_inner()).count(),
            memory_bytes: memory_stats::memory_stats().map(|m| m.physical_mem as u64),
            cpu_percent,
            db_bytes,
            uploads_bytes: uploads,
            messages,
        })
    }

    pub fn request_restart(&self) {
        self.control.send_replace(Control::Restart);
    }
}

/// Handle to a server started with [`start`].
pub struct RunningServer {
    pub local_addr: SocketAddr,
    pub tls_fingerprint: Option<String>,
    /// One-time code to create the owner account; `None` once an owner exists.
    pub setup_code: Option<String>,
    pub state: Arc<AppState>,
    handle: axum_server::Handle<SocketAddr>,
    task: tokio::task::JoinHandle<std::io::Result<()>>,
    media: Option<media::MediaService>,
    maint: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    /// Resolves when an admin requested a restart through the API.
    pub async fn restart_requested(&self) {
        let mut rx = self.state.control.subscribe();
        let _ = rx.wait_for(|c| *c == Control::Restart).await;
    }

    pub async fn shutdown(self) {
        tracing::info!("shutting down");
        // 1012 = service restart: clients reconnect automatically.
        self.state.hub.disconnect_all(1012, "Server wird neu gestartet");
        tokio::time::sleep(Duration::from_millis(150)).await;
        self.handle.graceful_shutdown(Some(Duration::from_secs(3)));
        let _ = self.task.await;
        self.maint.abort();
        if let Some(m) = self.media {
            m.stop().await;
        }
        self.state.db.close();
        tracing::info!("server stopped");
    }
}

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("Datenverzeichnis nicht nutzbar: {0}")]
    DataDir(std::io::Error),
    #[error("Datenbank konnte nicht geöffnet werden: {0}")]
    Database(String),
    #[error("TLS-Zertifikat konnte nicht geladen werden: {0}")]
    Tls(std::io::Error),
    #[error("Port {port} auf {bind} konnte nicht geöffnet werden: {err} (wird er bereits verwendet?)")]
    Bind { bind: String, port: u16, err: std::io::Error },
    #[error("Ungültige Konfiguration: {0}")]
    Config(String),
}

pub fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("nexus.db")
}

/// Starts the server. `data_dir` holds the database, uploads, TLS material and backups.
pub async fn start(cfg: Config, data_dir: &Path) -> Result<RunningServer, StartError> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    cfg.validate().map_err(|e| StartError::Config(e.join("; ")))?;
    for d in ["uploads", "uploads/avatars", "backups"] {
        std::fs::create_dir_all(data_dir.join(d)).map_err(StartError::DataDir)?;
    }
    maintenance::apply_pending_restore(data_dir).map_err(|e| StartError::Database(e.to_string()))?;
    let db = Db::open(&db_path(data_dir)).map_err(|e| StartError::Database(e.to_string()))?;

    let (settings, perm_cache, setup_code, turn_secret) = db
        .with(|c| -> ApiResult<_> {
            store::init_defaults(c)?;
            let settings = store::get_settings(c)?;
            let pc = store::load_perm_cache(c)?;
            let mut setup = None;
            if store::count_owners(c)? == 0 {
                setup = store::owner_setup_code(c)?;
                if setup.is_none() {
                    let code = util::random_code(12);
                    store::create_invite(c, &code, None, None, Some(1), None, true)?;
                    setup = Some(code);
                }
            }
            let secret = match store::get_kv(c, "turn_secret")? {
                Some(s) => s,
                None => {
                    let s = util::random_hex(32);
                    store::put_kv(c, "turn_secret", &s)?;
                    s
                }
            };
            Ok((settings, pc, setup, secret))
        })
        .map_err(|e| StartError::Database(e.msg))?;

    let setup_file = data_dir.join("setup-code.txt");
    match &setup_code {
        Some(code) => {
            let _ = std::fs::write(&setup_file, format!("{code}\n"));
            tracing::warn!(
                "Noch kein Serverinhaber vorhanden. Einrichtungscode: {code} (auch in {})",
                setup_file.display()
            );
        }
        None => {
            let _ = std::fs::remove_file(&setup_file);
        }
    }

    let tls = if cfg.tls.enabled {
        let names = [cfg.public_host.clone()];
        Some(tls::load_or_create(&cfg.tls, data_dir, &names).map_err(StartError::Tls)?)
    } else {
        tracing::warn!("TLS ist deaktiviert – nur hinter einem TLS-Reverse-Proxy oder zum Testen verwenden");
        None
    };

    let bind_ip: std::net::IpAddr = cfg.bind.parse().map_err(|_| StartError::Config("bind".into()))?;
    let addr = SocketAddr::new(bind_ip, cfg.port);
    let listener = std::net::TcpListener::bind(addr)
        .map_err(|err| StartError::Bind { bind: cfg.bind.clone(), port: cfg.port, err })?;
    listener.set_nonblocking(true).map_err(StartError::DataDir)?;
    let local_addr = listener.local_addr().map_err(StartError::DataDir)?;

    let media = match media::start(&cfg.media, bind_ip, &turn_secret).await {
        Ok(m) => m,
        Err(e) => {
            tracing::error!(error = %e, port = cfg.media.udp_port, "STUN/TURN konnte nicht gestartet werden; Sprachverbindungen über NAT sind eingeschränkt");
            None
        }
    };

    let (control, _) = tokio::sync::watch::channel(Control::Run);
    let state = Arc::new(AppState {
        auth_limiter: ratelimit::IpLimiter::new(cfg.limits.auth_per_min, cfg.limits.auth_burst),
        upload_limiter: ratelimit::IpLimiter::new(60.0, 30.0),
        cfg,
        data_dir: data_dir.to_path_buf(),
        db,
        settings: RwLock::new(settings),
        perms: RwLock::new(perm_cache),
        hub: Hub::default(),
        voice: Mutex::new(Default::default()),
        started: Instant::now(),
        turn_secret,
        fingerprint: tls.as_ref().map(|t| t.fingerprint.clone()),
        control,
        cpu_sample: Mutex::new(None),
    });

    let app = http::router(state.clone());
    let handle = axum_server::Handle::new();
    let make = app.into_make_service_with_connect_info::<SocketAddr>();
    let task = match tls {
        Some(t) => {
            let rc = axum_server::tls_rustls::RustlsConfig::from_pem(t.cert_pem, t.key_pem).await.map_err(StartError::Tls)?;
            let server = axum_server::tls_rustls::from_tcp_rustls(listener, rc).map_err(StartError::DataDir)?.handle(handle.clone());
            tokio::spawn(server.serve(make))
        }
        None => {
            let server = axum_server::from_tcp(listener).map_err(StartError::DataDir)?.handle(handle.clone());
            tokio::spawn(server.serve(make))
        }
    };
    let maint = tokio::spawn(maintenance::run(state.clone()));
    tracing::info!(
        addr = %local_addr,
        tls = state.fingerprint.is_some(),
        fingerprint = state.fingerprint.as_deref().unwrap_or("-"),
        "NexusTalk-Server {VERSION} gestartet"
    );
    if state.cfg.is_exposed() {
        tracing::warn!("Server ist im Netzwerk erreichbar ({}). Registrierung: {:?}", state.cfg.bind, state.settings().registration_mode);
    }
    Ok(RunningServer {
        local_addr,
        tls_fingerprint: state.fingerprint.clone(),
        setup_code,
        state,
        handle,
        task,
        media,
        maint,
    })
}

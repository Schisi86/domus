//! Internet relay for servers behind CGNAT (e.g. Starlink) or routers without
//! port forwarding: an outgoing TCP tunnel to a public relay (bore protocol)
//! that exposes the local server port as `relay:port`. TLS stays end to end –
//! the relay only forwards encrypted bytes; clients pin the certificate.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const RELAY_HOST: &str = "bore.pub";

/// Per-server relay settings, stored next to the server data (`relay.json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelaySettings {
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Public port from the last session – requested again so invite links stay valid.
    #[serde(default)]
    pub port: Option<u16>,
}

fn yes() -> bool {
    true
}

impl Default for RelaySettings {
    fn default() -> Self {
        Self { enabled: true, port: None }
    }
}

fn settings_path(dir: &Path) -> PathBuf {
    dir.join("relay.json")
}

pub fn load(dir: &Path) -> RelaySettings {
    std::fs::read(settings_path(dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn save(dir: &Path, s: &RelaySettings) {
    if let Ok(data) = serde_json::to_vec_pretty(s) {
        let _ = std::fs::write(settings_path(dir), data);
    }
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RelayStatus {
    /// Public address, e.g. "bore.pub:41234", once the tunnel is up.
    pub address: Option<String>,
    pub connecting: bool,
    pub error: Option<String>,
}

/// Keeps the tunnel to the relay open (reconnecting with backoff) until aborted.
pub fn spawn(status: Arc<Mutex<Option<RelayStatus>>>, dir: PathBuf, local_port: u16) -> tauri::async_runtime::JoinHandle<()> {
    let set = move |f: &dyn Fn(&mut RelayStatus)| {
        let mut g = status.lock().unwrap_or_else(|p| p.into_inner());
        f(g.get_or_insert_with(RelayStatus::default));
    };
    tauri::async_runtime::spawn(async move {
        let mut backoff = 2u64;
        loop {
            let mut settings = load(&dir);
            set(&|s| {
                s.connecting = true;
                s.error = None;
            });
            let wanted = settings.port.unwrap_or(0);
            match bore_cli::client::Client::new("127.0.0.1", local_port, RELAY_HOST, wanted, None).await {
                Ok(client) => {
                    let port = client.remote_port();
                    if settings.port != Some(port) {
                        settings.port = Some(port);
                        save(&dir, &settings);
                    }
                    let address = format!("{RELAY_HOST}:{port}");
                    tracing::info!(%address, "Internet-Relay verbunden");
                    set(&|s| {
                        s.address = Some(address.clone());
                        s.connecting = false;
                        s.error = None;
                    });
                    backoff = 2;
                    let res = client.listen().await;
                    let msg = res.err().map(|e| e.to_string()).unwrap_or_else(|| "Verbindung zum Relay beendet".into());
                    tracing::warn!(error = %msg, "Internet-Relay getrennt – neuer Versuch");
                    set(&|s| {
                        s.connecting = true;
                        s.error = Some(msg.clone());
                    });
                }
                Err(e) => {
                    let msg = e.to_string();
                    if wanted != 0 && msg.contains("already in use") {
                        // Our old port is taken: take a new one right away.
                        settings.port = None;
                        save(&dir, &settings);
                        continue;
                    }
                    tracing::warn!(error = %msg, "Internet-Relay nicht erreichbar");
                    set(&|s| {
                        s.connecting = false;
                        s.error = Some(msg.clone());
                    });
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(60);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn settings_default_to_enabled_and_roundtrip() {
        let dir = std::env::temp_dir().join(format!("nx-relay-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load(&dir).enabled);
        save(&dir, &RelaySettings { enabled: false, port: Some(4242) });
        let s = load(&dir);
        assert!(!s.enabled);
        assert_eq!(s.port, Some(4242));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live check against the public relay:
    /// `cargo test -p nexustalk relay_roundtrip -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn relay_roundtrip() {
        tauri::async_runtime::block_on(async {
            let local = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = local.local_addr().unwrap().port();
            tokio::spawn(async move {
                loop {
                    let (mut s, _) = local.accept().await.unwrap();
                    tokio::spawn(async move {
                        let mut buf = [0u8; 64];
                        let n = s.read(&mut buf).await.unwrap();
                        s.write_all(&buf[..n]).await.unwrap();
                    });
                }
            });
            let t0 = std::time::Instant::now();
            let client = bore_cli::client::Client::new("127.0.0.1", port, RELAY_HOST, 0, None).await.expect("relay reachable");
            let remote = client.remote_port();
            println!("tunnel {RELAY_HOST}:{remote} after {:?}", t0.elapsed());
            tokio::spawn(client.listen());
            let mut c = tokio::net::TcpStream::connect((RELAY_HOST, remote)).await.unwrap();
            c.write_all(b"nexustalk-ping").await.unwrap();
            let mut buf = [0u8; 64];
            let n = tokio::time::timeout(Duration::from_secs(10), c.read(&mut buf)).await.unwrap().unwrap();
            assert_eq!(&buf[..n], b"nexustalk-ping");
            println!("roundtrip ok in {:?}", t0.elapsed());
        });
    }
}

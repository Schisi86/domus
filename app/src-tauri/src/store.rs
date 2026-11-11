//! Client configuration: saved servers, session tokens and UI settings.
//!
//! Stored as JSON in `%APPDATA%\NexusTalk\client.json`. Session tokens are
//! encrypted with the Windows Data Protection API (bound to the Windows user
//! account); passwords are never stored.

use std::path::PathBuf;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SavedServer {
    pub id: String,
    pub address: String,
    #[serde(default)]
    pub fingerprint: Option<String>,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub username: String,
    /// Plain token in memory / over IPC; never written to disk as-is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_enc: Option<String>,
    #[serde(default)]
    pub hosted: bool,
    /// Which of this app's hosted servers the entry belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ClientConfig {
    #[serde(default)]
    pub servers: Vec<SavedServer>,
    /// Opaque UI settings owned by the frontend.
    #[serde(default)]
    pub settings: serde_json::Value,
    #[serde(default)]
    pub host_autostart: bool,
    /// Start the hosted servers together with the app (default: on).
    #[serde(default = "default_true")]
    pub hosts_autostart: bool,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
}

fn default_true() -> bool {
    true
}

pub struct ConfigStore {
    pub path: PathBuf,
}

#[derive(Serialize)]
pub struct Loaded {
    config: ClientConfig,
    warning: Option<String>,
}

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    fn run(data: &[u8], protect: bool) -> Option<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
        // SAFETY: input points to valid memory for its length; on success the
        // OS allocates `out`, which we copy and free with LocalFree.
        let ok = unsafe {
            if protect {
                CryptProtectData(&input, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&input, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 || out.pbData.is_null() {
            return None;
        }
        let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec() };
        unsafe { LocalFree(out.pbData as _) };
        Some(v)
    }

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        run(data, true)
    }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        run(data, false)
    }
}

#[cfg(not(windows))]
mod dpapi {
    // Non-Windows builds are development only; tokens are merely encoded.
    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        Some(data.to_vec())
    }
}

/// Protects bytes with the Windows user account (DPAPI).
pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
    dpapi::protect(data)
}

pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
    dpapi::unprotect(data)
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

impl ConfigStore {
    pub fn load(&self) -> (ClientConfig, Option<String>) {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(t) => t,
            Err(_) => return (ClientConfig { minimize_to_tray: true, hosts_autostart: true, ..Default::default() }, None),
        };
        match serde_json::from_str::<ClientConfig>(&text) {
            Ok(mut cfg) => {
                for s in &mut cfg.servers {
                    s.token = s
                        .token_enc
                        .take()
                        .and_then(|e| b64().decode(e).ok())
                        .and_then(|e| dpapi::unprotect(&e))
                        .and_then(|t| String::from_utf8(t).ok());
                }
                (cfg, None)
            }
            Err(e) => {
                let backup = self.path.with_extension("json.broken");
                let _ = std::fs::rename(&self.path, &backup);
                tracing::error!(error = %e, "client config damaged, reset to defaults");
                (
                    ClientConfig { minimize_to_tray: true, ..Default::default() },
                    Some(format!("Die Konfiguration war beschädigt und wurde zurückgesetzt (Kopie: {}).", backup.display())),
                )
            }
        }
    }

    pub fn save(&self, cfg: &ClientConfig) -> Result<(), String> {
        let mut disk = cfg.clone();
        for s in &mut disk.servers {
            s.token_enc = s.token.take().and_then(|t| dpapi::protect(t.as_bytes())).map(|e| b64().encode(e));
        }
        let text = serde_json::to_string_pretty(&disk).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| format!("Konfiguration konnte nicht gespeichert werden: {e}"))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn config_load(store: State<'_, ConfigStore>) -> Loaded {
    let (config, warning) = store.load();
    Loaded { config, warning }
}

#[tauri::command]
pub fn config_save(store: State<'_, ConfigStore>, config: ClientConfig) -> Result<(), String> {
    store.save(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_encrypted_on_disk() {
        let dir = std::env::temp_dir().join(format!("nx-client-{}", std::process::id()));
        let store = ConfigStore { path: dir.join("client.json") };
        let cfg = ClientConfig {
            servers: vec![SavedServer { id: "a".into(), address: "x".into(), token: Some("secret-token-123".into()), ..Default::default() }],
            ..Default::default()
        };
        store.save(&cfg).unwrap();
        let raw = std::fs::read_to_string(&store.path).unwrap();
        assert!(!raw.contains("secret-token-123"));
        let (loaded, warn) = store.load();
        assert!(warn.is_none());
        assert_eq!(loaded.servers[0].token.as_deref(), Some("secret-token-123"));
        std::fs::write(&store.path, "{ broken").unwrap();
        let (loaded, warn) = store.load();
        assert!(warn.is_some());
        assert!(loaded.servers.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
}

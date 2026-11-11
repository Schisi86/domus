//! Local helpers for the UI: device-bound secrets (the private key for
//! end-to-end encrypted direct messages) and writing large files chunk by chunk
//! (direct file transfer, clips) without holding them in memory.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use base64::Engine;
use tauri::ipc::{InvokeBody, Request};

use crate::store::{protect, unprotect};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

// ------------------------------------------------------------- secrets

fn secrets_path() -> PathBuf {
    crate::app_dir().join("secrets.json")
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 120 && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

fn load_secrets(path: &Path) -> HashMap<String, String> {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn secret_read(path: &Path, name: &str) -> Option<String> {
    let enc = load_secrets(path).remove(name)?;
    let raw = base64::engine::general_purpose::STANDARD.decode(enc).ok()?;
    String::from_utf8(unprotect(&raw)?).ok()
}

pub fn secret_write(path: &Path, name: &str, value: Option<&str>) -> Result<(), String> {
    let mut all = load_secrets(path);
    match value {
        Some(v) => {
            let enc = protect(v.as_bytes()).ok_or("Schlüssel konnte nicht geschützt werden")?;
            all.insert(name.to_string(), base64::engine::general_purpose::STANDARD.encode(enc));
        }
        None => {
            all.remove(name);
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Reads a secret that is protected with the Windows user account (DPAPI).
#[tauri::command]
pub fn secret_get(name: String) -> Option<String> {
    valid_name(&name).then(|| secret_read(&secrets_path(), &name)).flatten()
}

/// Stores (or with `value: null` removes) a device-bound secret.
#[tauri::command]
pub fn secret_set(name: String, value: Option<String>) -> Result<(), String> {
    if !valid_name(&name) || value.as_ref().is_some_and(|v| v.len() > 16 * 1024) {
        return Err("Ungültiger Eintrag".into());
    }
    secret_write(&secrets_path(), &name, value.as_deref())
}

// ------------------------------------------------------------- file writer

struct Sink {
    file: std::io::BufWriter<std::fs::File>,
    path: PathBuf,
    written: u64,
}

static SINKS: Mutex<Option<HashMap<u32, Sink>>> = Mutex::new(None);
static NEXT_SINK: AtomicU32 = AtomicU32::new(1);

/// Opens `path` for writing (the user picked it in the save dialog) and returns
/// a handle for `file_save_chunk`.
#[tauri::command]
pub fn file_save_begin(path: String) -> Result<u32, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("Ungültiger Pfad".into());
    }
    let file = std::fs::File::create(&path).map_err(|e| format!("Datei konnte nicht angelegt werden: {e}"))?;
    let id = NEXT_SINK.fetch_add(1, Ordering::SeqCst);
    lock(&SINKS).get_or_insert_with(HashMap::new).insert(id, Sink { file: std::io::BufWriter::with_capacity(1 << 20, file), path, written: 0 });
    Ok(id)
}

fn sink_write(id: u32, data: &[u8]) -> Result<u64, String> {
    let mut sinks = lock(&SINKS);
    let sink = sinks.as_mut().and_then(|m| m.get_mut(&id)).ok_or("Übertragung nicht gefunden")?;
    sink.file.write_all(data).map_err(|e| format!("Schreiben fehlgeschlagen: {e}"))?;
    sink.written += data.len() as u64;
    Ok(sink.written)
}

/// Appends raw bytes (the request body) to the file opened as `x-id`.
#[tauri::command]
pub fn file_save_chunk(request: Request<'_>) -> Result<u64, String> {
    let id: u32 = request.headers().get("x-id").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).ok_or("x-id fehlt")?;
    let InvokeBody::Raw(data) = request.body() else {
        return Err("Rohdaten erwartet".into());
    };
    sink_write(id, data)
}

/// Finishes the file; with `keep: false` the partial file is deleted.
#[tauri::command]
pub fn file_save_end(id: u32, keep: bool) -> Result<u64, String> {
    let sink = lock(&SINKS).as_mut().and_then(|m| m.remove(&id)).ok_or("Übertragung nicht gefunden")?;
    let Sink { mut file, path, written } = sink;
    let flushed = file.flush();
    drop(file);
    if !keep {
        let _ = std::fs::remove_file(&path);
        return Ok(0);
    }
    flushed.map_err(|e| format!("Schreiben fehlgeschlagen: {e}"))?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_round_trip_and_are_not_stored_in_plain_text() {
        let path = std::env::temp_dir().join(format!("nx-secrets-{}.json", std::process::id()));
        secret_write(&path, "e2e.main.7", Some("private-key-material")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        if cfg!(windows) {
            assert!(!raw.contains("private-key-material"));
        }
        assert_eq!(secret_read(&path, "e2e.main.7").as_deref(), Some("private-key-material"));
        assert_eq!(secret_read(&path, "other"), None);
        secret_write(&path, "e2e.main.7", None).unwrap();
        assert_eq!(secret_read(&path, "e2e.main.7"), None);
        let _ = std::fs::remove_file(&path);
        assert!(valid_name("e2e.srv-1:42") && !valid_name("../x") && !valid_name(""));
    }

    #[test]
    fn file_sink_writes_and_discards() {
        let dir = std::env::temp_dir();
        let keep = dir.join(format!("nx-sink-keep-{}.bin", std::process::id()));
        let id = file_save_begin(keep.to_string_lossy().into_owned()).unwrap();
        assert_eq!(sink_write(id, b"hello ").unwrap(), 6);
        assert_eq!(sink_write(id, b"world").unwrap(), 11);
        assert_eq!(file_save_end(id, true).unwrap(), 11);
        assert_eq!(std::fs::read(&keep).unwrap(), b"hello world");
        let _ = std::fs::remove_file(&keep);

        let drop_path = dir.join(format!("nx-sink-drop-{}.bin", std::process::id()));
        let id = file_save_begin(drop_path.to_string_lossy().into_owned()).unwrap();
        assert_eq!(file_save_end(id, false).unwrap(), 0);
        assert!(!drop_path.exists());
        assert!(file_save_begin("relative.bin".into()).is_err());
        assert!(file_save_end(9999, true).is_err());
        assert!(sink_write(9999, b"x").is_err());
    }
}

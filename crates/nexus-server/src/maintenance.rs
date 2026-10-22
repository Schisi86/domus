//! Periodic housekeeping, backups and restore.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::db::{self, SCHEMA_VERSION};
use crate::error::{ApiError, ApiResult};
use crate::util::now_ms;
use crate::{files, store, AppState};

const MAX_BACKUPS: usize = 20;

/// Runs once a minute after start and then hourly. Cheap queries only.
pub async fn run(st: Arc<AppState>) {
    tokio::time::sleep(Duration::from_secs(60)).await;
    let mut tick = tokio::time::interval(Duration::from_secs(3600));
    loop {
        tick.tick().await;
        if let Err(e) = housekeeping(&st).await {
            tracing::error!(error = %e, "housekeeping failed");
        }
    }
}

pub async fn housekeeping(st: &Arc<AppState>) -> ApiResult<()> {
    let max_age = st.cfg.limits.session_days as i64 * 86_400_000;
    let retention = st.settings().retention_days;
    let (sessions, invites, stale, purged) = st
        .db
        .call(move |c| {
            let sessions = store::prune_sessions(c, max_age)?;
            let invites = store::prune_invites(c)?;
            let stale = store::take_stale_uploads(c, 3_600_000)?;
            let purged = if retention > 0 {
                Some(store::purge_messages_before(c, now_ms() - retention as i64 * 86_400_000)?)
            } else {
                None
            };
            store::prune_audit(c, 10_000)?;
            Ok((sessions, invites, stale, purged))
        })
        .await?;
    files::remove_attachments(st, &stale);
    let mut purged_count = 0;
    if let Some((n, files_)) = purged {
        files::remove_attachments(st, &files_);
        purged_count = n;
    }
    // Leftover partial uploads from crashes.
    if let Ok(rd) = std::fs::read_dir(st.uploads_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let old = e.metadata().and_then(|m| m.modified()).map(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(3600));
            if name.starts_with("tmp-") && old.unwrap_or(false) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    if sessions + invites + stale.len() + purged_count > 0 {
        tracing::info!(sessions, invites, stale_uploads = stale.len(), purged_messages = purged_count, "housekeeping");
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub size: u64,
    pub created_at: i64,
}

/// `YYYYMMDD-HHMMSS` in UTC without pulling in a date library.
pub fn utc_stamp(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

fn valid_backup_name(name: &str) -> bool {
    name.starts_with("nexus-")
        && name.ends_with(".db")
        && name.len() < 64
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
        && !name.contains("..")
}

pub async fn create_backup(st: &AppState) -> ApiResult<BackupInfo> {
    let dir = st.backups_dir();
    std::fs::create_dir_all(&dir)?;
    let name = format!("nexus-{}.db", utc_stamp(now_ms()));
    let path = dir.join(&name);
    let p = path.to_string_lossy().to_string();
    st.db
        .call(move |c| {
            c.execute("VACUUM INTO ?1", rusqlite::params![p])?;
            Ok(())
        })
        .await?;
    let size = std::fs::metadata(&path)?.len();
    // Rotate old backups.
    let mut all = list_backups(st)?;
    if all.len() > MAX_BACKUPS {
        all.sort_by_key(|b| b.created_at);
        for b in &all[..all.len() - MAX_BACKUPS] {
            let _ = std::fs::remove_file(dir.join(&b.name));
        }
    }
    tracing::info!(%name, size, "backup created");
    Ok(BackupInfo { name, size, created_at: now_ms() })
}

pub fn list_backups(st: &AppState) -> ApiResult<Vec<BackupInfo>> {
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(st.backups_dir()) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !valid_backup_name(&name) {
                continue;
            }
            let m = e.metadata()?;
            let created = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            v.push(BackupInfo { name, size: m.len(), created_at: created });
        }
    }
    v.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(v)
}

/// Checks that a file is a NexusTalk database this version can open.
pub fn verify_backup(path: &Path) -> Result<(), String> {
    let c = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("Datei kann nicht geöffnet werden: {e}"))?;
    let v = db::schema_version(&c).map_err(|e| format!("Keine gültige Datenbank: {e}"))?;
    if v == 0 || v > SCHEMA_VERSION {
        return Err(format!("Nicht unterstützte Schemaversion {v}"));
    }
    let ok: String = c.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err(format!("Datenbank ist beschädigt: {ok}"));
    }
    c.query_row("SELECT count(*) FROM users", [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Copies a backup so that it replaces the live database on the next start.
pub fn stage_restore(st: &AppState, name: &str) -> ApiResult<()> {
    if !valid_backup_name(name) {
        return Err(ApiError::invalid("Ungültiger Sicherungsname"));
    }
    let src = st.backups_dir().join(name);
    if !src.exists() {
        return Err(ApiError::not_found("Sicherung"));
    }
    stage_restore_file(&src, &st.data_dir).map_err(ApiError::invalid)
}

pub fn stage_restore_file(src: &Path, data_dir: &Path) -> Result<(), String> {
    verify_backup(src)?;
    std::fs::copy(src, data_dir.join("restore-pending.db")).map_err(|e| e.to_string())?;
    Ok(())
}

/// Swaps in a staged restore before the database is opened. The previous
/// database is kept as `nexus.db.before-restore-<stamp>`.
pub fn apply_pending_restore(data_dir: &Path) -> std::io::Result<()> {
    let pending = data_dir.join("restore-pending.db");
    if !pending.exists() {
        return Ok(());
    }
    let live = crate::db_path(data_dir);
    if live.exists() {
        let keep = data_dir.join(format!("nexus.db.before-restore-{}", utc_stamp(now_ms())));
        std::fs::rename(&live, keep)?;
    }
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{}", live.display(), suffix));
    }
    std::fs::rename(&pending, &live)?;
    tracing::warn!("Datenbank aus Sicherung wiederhergestellt");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamps() {
        assert_eq!(utc_stamp(0), "19700101-000000");
        assert_eq!(utc_stamp(1_793_145_600_000), "20261028-000000");
        assert_eq!(utc_stamp(951_786_123_000), "20000229-010203");
    }

    #[test]
    fn backup_names() {
        assert!(valid_backup_name("nexus-20260101-000000.db"));
        assert!(!valid_backup_name("../nexus.db"));
        assert!(!valid_backup_name("nexus-..\\x.db"));
        assert!(!valid_backup_name("other.db"));
    }
}

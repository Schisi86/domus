//! SQLite access and schema migrations.
//!
//! A single connection behind a mutex is plenty for the target size (a few
//! hundred users) and keeps memory low. Async callers go through
//! [`Db::call`], which runs the closure on tokio's blocking pool.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{ApiError, ApiResult};

#[derive(Clone)]
pub struct Db {
    /// `None` once [`Db::close`] was called (server shut down).
    conn: Arc<Mutex<Option<Connection>>>,
}

/// Each entry upgrades the schema by one version (`PRAGMA user_version`).
const MIGRATIONS: &[&str] = &[
    // v1: initial schema
    r#"
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','banned','deleted')),
        is_owner INTEGER NOT NULL DEFAULT 0,
        avatar TEXT,
        status_text TEXT NOT NULL DEFAULT '',
        presence TEXT NOT NULL DEFAULT 'online',
        created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
        token_hash BLOB PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        device TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX sessions_user ON sessions(user_id);
    CREATE TABLE roles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        permissions INTEGER NOT NULL,
        position INTEGER NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE user_roles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, role_id)
    );
    CREATE TABLE categories (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE channels (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('text','voice','dm')),
        name TEXT NOT NULL,
        topic TEXT NOT NULL DEFAULT '',
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
    );
    CREATE TABLE channel_overrides (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        allow INTEGER NOT NULL DEFAULT 0,
        deny INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, role_id)
    );
    CREATE TABLE dm_members (
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (channel_id, user_id)
    );
    CREATE INDEX dm_members_user ON dm_members(user_id);
    CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        author_id INTEGER NOT NULL REFERENCES users(id),
        content TEXT NOT NULL,
        reply_to INTEGER,
        created_at INTEGER NOT NULL,
        edited_at INTEGER
    );
    CREATE INDEX messages_channel ON messages(channel_id, id);
    CREATE INDEX messages_author ON messages(author_id);
    CREATE TABLE mentions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        channel_id INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id)
    );
    CREATE INDEX mentions_user ON mentions(user_id, channel_id, message_id);
    CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
        channel_id INTEGER NOT NULL,
        uploader_id INTEGER NOT NULL,
        filename TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX attachments_message ON attachments(message_id);
    CREATE TABLE invites (
        code TEXT PRIMARY KEY,
        created_by INTEGER,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_uses INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
        owner_setup INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE read_states (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
        last_read_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, channel_id)
    );
    CREATE TABLE relationships (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('friend','outgoing','incoming','blocked')),
        PRIMARY KEY (user_id, target_id)
    );
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor_id INTEGER,
        action TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(content, content='messages', content_rowid='id');
    CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
    CREATE TRIGGER messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;
    "#,
    // v2: reactions and pinned messages
    r#"
    CREATE TABLE reactions (
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        emoji TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
    );
    CREATE INDEX reactions_message ON reactions(message_id);
    ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
    CREATE INDEX messages_pinned ON messages(channel_id, pinned_at) WHERE pinned_at IS NOT NULL;
    "#,
    // v3: moderation (timeouts, new permissions), slow mode, voice user limit,
    // polls and forwarded messages
    r#"
    ALTER TABLE users ADD COLUMN timeout_until INTEGER;
    ALTER TABLE channels ADD COLUMN slowmode INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE channels ADD COLUMN user_limit INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN forwarded_from INTEGER;
    CREATE TABLE polls (
        message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        question TEXT NOT NULL,
        options TEXT NOT NULL,
        multi INTEGER NOT NULL DEFAULT 0,
        ends_at INTEGER
    );
    CREATE TABLE poll_votes (
        message_id INTEGER NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        option INTEGER NOT NULL,
        PRIMARY KEY (message_id, user_id, option)
    );
    -- Roles that could ban may now also kick, time out, mute and move members.
    UPDATE roles SET permissions = permissions | 491520
        WHERE (permissions & 2048) != 0 AND (permissions & 1073741824) = 0;
    "#,
    // v4: profile bio and banner colors
    r#"
    ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
    ALTER TABLE users ADD COLUMN banner TEXT NOT NULL DEFAULT '';
    "#,
    // v5: public keys for end-to-end encrypted direct messages. The server only
    // stores and hands out public keys; private keys never leave the devices.
    r#"
    CREATE TABLE e2e_keys (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kid TEXT NOT NULL,
        public_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, kid)
    );
    "#,
    // v6: per-user state of direct messages (archive, pin, "delete for me")
    // and the read-receipt preference.
    r#"
    ALTER TABLE dm_members ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE dm_members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE dm_members ADD COLUMN cleared_before INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1;
    "#,
];

pub const SCHEMA_VERSION: i64 = MIGRATIONS.len() as i64;

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Db> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> rusqlite::Result<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> rusqlite::Result<Db> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -4000;",
        )?;
        migrate(&mut conn)?;
        Ok(Db { conn: Arc::new(Mutex::new(Some(conn))) })
    }

    /// Runs `f` with the connection on the blocking thread pool.
    pub async fn call<F, R>(&self, f: F) -> ApiResult<R>
    where
        F: FnOnce(&mut Connection) -> ApiResult<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().unwrap_or_else(|p| p.into_inner());
            match guard.as_mut() {
                Some(c) => f(c),
                None => Err(ApiError::new(crate::error::Code::Internal, "Datenbank ist geschlossen")),
            }
        })
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "database task panicked");
            ApiError::internal()
        })?
    }

    /// Synchronous access, for startup code and tests.
    /// Panics if the database was closed.
    pub fn with<R>(&self, f: impl FnOnce(&mut Connection) -> R) -> R {
        let mut guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        f(guard.as_mut().expect("database closed"))
    }

    /// Checkpoints the WAL and closes the file handle. Later calls fail with an
    /// internal error. Needed on Windows, where open files cannot be replaced
    /// (backup restore) while background tasks still hold a reference.
    pub fn close(&self) {
        let mut guard = self.conn.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(c) = guard.take() {
            let _ = c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            if let Err((_, e)) = c.close() {
                tracing::warn!(error = %e, "closing database failed");
            }
        }
    }
}

pub fn schema_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let current = schema_version(conn)?;
    if current > SCHEMA_VERSION {
        return Err(rusqlite::Error::InvalidParameterName(format!(
            "Datenbank stammt aus einer neueren Version (Schema {current}, unterstützt {SCHEMA_VERSION})"
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
        tracing::info!(version = i + 1, "database migrated");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_db_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("nx-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.db");
        let _ = std::fs::remove_file(&p);
        {
            let db = Db::open(&p).unwrap();
            assert_eq!(db.with(|c| schema_version(c).unwrap()), SCHEMA_VERSION);
        }
        let db = Db::open(&p).unwrap();
        assert_eq!(db.with(|c| schema_version(c).unwrap()), SCHEMA_VERSION);
        drop(db);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fts5_is_available() {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute("INSERT INTO users (username, password_hash, created_at) VALUES ('a','x',0)", []).unwrap();
            c.execute("INSERT INTO channels (kind, name, created_at) VALUES ('text','c',0)", []).unwrap();
            c.execute("INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (1,1,'Hallo Welt',0)", [])
                .unwrap();
            let n: i64 = c
                .query_row("SELECT count(*) FROM messages_fts WHERE messages_fts MATCH '\"welt\"'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1);
        });
    }
}

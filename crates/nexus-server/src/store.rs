//! Data model and SQL queries. All functions are synchronous and take a
//! connection, which makes them easy to unit test and to group in transactions.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult, Code};
use crate::perms::{self, ChannelInfo, PermCache, Perms, RoleInfo};
use crate::util::now_ms;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub status_text: String,
    pub is_owner: bool,
    pub status: String,
    pub presence_pref: String,
    pub created_at: i64,
    pub timeout_until: Option<i64>,
    /// "Über mich" text.
    pub bio: String,
    /// Profile banner: "" or one/two colors "#rrggbb[,#rrggbb]".
    pub banner: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Role {
    pub id: i64,
    pub name: String,
    pub permissions: Perms,
    pub position: i64,
    pub color: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Channel {
    pub id: i64,
    pub kind: String,
    pub name: String,
    pub topic: String,
    pub category_id: Option<i64>,
    pub position: i64,
    pub last_message_id: Option<i64>,
    pub slowmode: i64,
    pub user_limit: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Override {
    pub role_id: i64,
    pub allow: Perms,
    pub deny: Perms,
}

#[derive(Debug, Clone, Serialize)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub size: i64,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReplyPreview {
    pub id: i64,
    pub author_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub id: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: String,
    pub reply_to: Option<i64>,
    pub reply_preview: Option<ReplyPreview>,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub mentions: Vec<i64>,
    pub attachments: Vec<Attachment>,
    pub reactions: Vec<Reaction>,
    pub pinned_at: Option<i64>,
    /// Original author when the message was forwarded.
    pub forwarded_from: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll: Option<Poll>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Poll {
    pub question: String,
    pub options: Vec<PollOption>,
    pub multi: bool,
    pub ends_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PollOption {
    pub text: String,
    pub voters: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Reaction {
    pub emoji: String,
    pub users: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Invite {
    pub code: String,
    pub created_by: Option<i64>,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub max_uses: Option<i64>,
    pub uses: i64,
    pub role_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    pub id: i64,
    pub ts: i64,
    pub actor_id: Option<i64>,
    pub action: String,
    pub target: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct DmChannel {
    pub channel_id: i64,
    pub user_id: i64,
    pub last_message_id: Option<i64>,
    /// Moved to the archive by this user.
    pub archived: bool,
    /// Pinned to the top by this user.
    pub pinned: bool,
    /// "Deleted for me": older messages are hidden for this user. The chat is
    /// hidden while no newer message exists.
    pub cleared_before: i64,
    /// How far the other person has read (only if both allow read receipts).
    pub peer_read: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RegistrationMode {
    /// Nobody can register (except with the one-time owner setup code).
    Closed,
    /// Registration requires a valid invite code. Default.
    Invite,
    /// Anyone can register, an admin must approve the account first.
    Approval,
    /// Anyone can register and use the server immediately.
    Open,
}

/// Community settings that admins can change at runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerSettings {
    pub name: String,
    pub description: String,
    pub registration_mode: RegistrationMode,
    pub uploads_enabled: bool,
    pub max_upload_mb: u32,
    pub max_storage_mb: u32,
    /// 0 = keep messages forever.
    pub retention_days: u32,
    pub icon: Option<String>,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            name: "Domus-Server".into(),
            description: String::new(),
            registration_mode: RegistrationMode::Invite,
            uploads_enabled: true,
            max_upload_mb: 25,
            max_storage_mb: 2048,
            retention_days: 0,
            icon: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Settings & initialization
// ---------------------------------------------------------------------------

pub fn get_settings(c: &Connection) -> ApiResult<ServerSettings> {
    let v: Option<String> = c.query_row("SELECT value FROM settings WHERE key='server'", [], |r| r.get(0)).optional()?;
    Ok(v.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default())
}

pub fn put_settings(c: &Connection, s: &ServerSettings) -> ApiResult<()> {
    let json = serde_json::to_string(s).map_err(|_| ApiError::internal())?;
    c.execute(
        "INSERT INTO settings (key, value) VALUES ('server', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![json],
    )?;
    Ok(())
}

pub fn get_kv(c: &Connection, key: &str) -> ApiResult<Option<String>> {
    Ok(c.query_row("SELECT value FROM settings WHERE key=?1", params![key], |r| r.get(0)).optional()?)
}

pub fn put_kv(c: &Connection, key: &str, value: &str) -> ApiResult<()> {
    c.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// Creates default roles, channels and settings on a fresh database.
pub fn init_defaults(c: &mut Connection) -> ApiResult<bool> {
    let has_roles: i64 = c.query_row("SELECT count(*) FROM roles", [], |r| r.get(0))?;
    if has_roles > 0 {
        return Ok(false);
    }
    let tx = c.transaction()?;
    for (name, p, pos, color, def) in perms::DEFAULT_ROLES {
        tx.execute(
            "INSERT INTO roles (name, permissions, position, color, is_default) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, *p as i64, pos, color, def],
        )?;
    }
    let now = now_ms();
    tx.execute("INSERT INTO categories (name, position) VALUES ('Textkanäle', 0)", [])?;
    let text_cat = tx.last_insert_rowid();
    tx.execute("INSERT INTO categories (name, position) VALUES ('Sprachkanäle', 1)", [])?;
    let voice_cat = tx.last_insert_rowid();
    tx.execute(
        "INSERT INTO channels (kind, name, topic, category_id, position, created_at) VALUES ('text', 'allgemein', 'Allgemeiner Austausch', ?1, 0, ?2)",
        params![text_cat, now],
    )?;
    tx.execute(
        "INSERT INTO channels (kind, name, category_id, position, created_at) VALUES ('voice', 'Allgemein', ?1, 0, ?2)",
        params![voice_cat, now],
    )?;
    put_settings(&tx, &ServerSettings::default())?;
    tx.commit()?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------

const USER_COLS: &str = "id, username, display_name, avatar, status_text, is_owner, status, presence, created_at, timeout_until, bio, banner";

fn row_user(r: &Row) -> rusqlite::Result<User> {
    Ok(User {
        id: r.get(0)?,
        username: r.get(1)?,
        display_name: r.get(2)?,
        avatar: r.get(3)?,
        status_text: r.get(4)?,
        is_owner: r.get(5)?,
        status: r.get(6)?,
        presence_pref: r.get(7)?,
        created_at: r.get(8)?,
        timeout_until: r.get(9)?,
        bio: r.get(10)?,
        banner: r.get(11)?,
    })
}

pub fn user_by_id(c: &Connection, id: i64) -> ApiResult<Option<User>> {
    Ok(c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE id=?1"), params![id], row_user).optional()?)
}

/// Returns the user together with the password hash.
pub fn user_by_name(c: &Connection, name: &str) -> ApiResult<Option<(User, String)>> {
    Ok(c.query_row(
        &format!("SELECT {USER_COLS}, password_hash FROM users WHERE username=?1 AND status != 'deleted'"),
        params![name],
        |r| Ok((row_user(r)?, r.get::<_, String>(12)?)),
    )
    .optional()?)
}

pub fn password_hash(c: &Connection, id: i64) -> ApiResult<String> {
    Ok(c.query_row("SELECT password_hash FROM users WHERE id=?1", params![id], |r| r.get(0))?)
}

pub fn set_password_hash(c: &Connection, id: i64, hash: &str) -> ApiResult<()> {
    c.execute("UPDATE users SET password_hash=?2 WHERE id=?1", params![id, hash])?;
    Ok(())
}

pub fn create_user(c: &Connection, username: &str, hash: &str, status: &str, is_owner: bool) -> ApiResult<i64> {
    let res = c.execute(
        "INSERT INTO users (username, password_hash, status, is_owner, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![username, hash, status, is_owner, now_ms()],
    );
    match res {
        Ok(_) => Ok(c.last_insert_rowid()),
        Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => {
            Err(ApiError::new(Code::UsernameTaken, "Benutzername ist bereits vergeben"))
        }
        Err(e) => Err(e.into()),
    }
}

pub fn count_owners(c: &Connection) -> ApiResult<i64> {
    Ok(c.query_row("SELECT count(*) FROM users WHERE is_owner=1 AND status='active'", [], |r| r.get(0))?)
}

pub fn set_user_status(c: &Connection, id: i64, status: &str) -> ApiResult<()> {
    c.execute("UPDATE users SET status=?2 WHERE id=?1", params![id, status])?;
    Ok(())
}

pub fn update_profile(c: &Connection, id: i64, display_name: &str, status_text: &str) -> ApiResult<()> {
    c.execute("UPDATE users SET display_name=?2, status_text=?3 WHERE id=?1", params![id, display_name, status_text])?;
    Ok(())
}

pub fn set_avatar(c: &Connection, id: i64, avatar: Option<&str>) -> ApiResult<Option<String>> {
    let old: Option<String> = c.query_row("SELECT avatar FROM users WHERE id=?1", params![id], |r| r.get(0))?;
    c.execute("UPDATE users SET avatar=?2 WHERE id=?1", params![id, avatar])?;
    Ok(old)
}

pub fn set_bio_banner(c: &Connection, id: i64, bio: &str, banner: &str) -> ApiResult<()> {
    c.execute("UPDATE users SET bio=?2, banner=?3 WHERE id=?1", params![id, bio, banner])?;
    Ok(())
}

/// Recent messages that mention the user, newest first, only in the given channels.
pub fn mentions_of(c: &Connection, user_id: i64, channels: &[i64], limit: usize) -> ApiResult<Vec<Message>> {
    if channels.is_empty() {
        return Ok(Vec::new());
    }
    let ph = placeholders(channels.len());
    let sql = format!(
        "{MSG_SELECT} WHERE m.id IN (SELECT message_id FROM mentions WHERE user_id=?1) AND m.channel_id IN ({ph}) ORDER BY m.id DESC LIMIT {limit}"
    );
    let mut st = c.prepare(&sql)?;
    let mut args: Vec<rusqlite::types::Value> = vec![user_id.into()];
    args.extend(channels.iter().map(|x| rusqlite::types::Value::from(*x)));
    let mut msgs = st.query_map(rusqlite::params_from_iter(args), row_message)?.collect::<Result<Vec<_>, _>>()?;
    hydrate(c, &mut msgs)?;
    Ok(msgs)
}

pub fn set_timeout(c: &Connection, id: i64, until: Option<i64>) -> ApiResult<()> {
    c.execute("UPDATE users SET timeout_until=?2 WHERE id=?1", params![id, until])?;
    Ok(())
}

pub fn set_presence_pref(c: &Connection, id: i64, presence: &str) -> ApiResult<()> {
    c.execute("UPDATE users SET presence=?2 WHERE id=?1", params![id, presence])?;
    Ok(())
}

pub fn users_with_status(c: &Connection, status: &str) -> ApiResult<Vec<User>> {
    let mut st = c.prepare(&format!("SELECT {USER_COLS} FROM users WHERE status=?1 ORDER BY username"))?;
    let rows = st.query_map(params![status], row_user)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Removes an account but keeps a tombstone row so old messages stay attributable.
/// Returns stored avatar file name (to delete) if any.
pub fn delete_user(c: &mut Connection, id: i64, delete_messages: bool) -> ApiResult<(Option<String>, Vec<String>)> {
    let tx = c.transaction()?;
    let avatar: Option<String> = tx.query_row("SELECT avatar FROM users WHERE id=?1", params![id], |r| r.get(0))?;
    let mut files = Vec::new();
    if delete_messages {
        let mut st = tx.prepare(
            "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.author_id=?1",
        )?;
        files = st.query_map(params![id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        drop(st);
        tx.execute("DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE author_id=?1)", params![id])?;
        tx.execute("DELETE FROM messages WHERE author_id=?1", params![id])?;
    }
    tx.execute("DELETE FROM sessions WHERE user_id=?1", params![id])?;
    tx.execute("DELETE FROM user_roles WHERE user_id=?1", params![id])?;
    tx.execute("DELETE FROM relationships WHERE user_id=?1 OR target_id=?1", params![id])?;
    tx.execute("DELETE FROM read_states WHERE user_id=?1", params![id])?;
    tx.execute(
        "UPDATE users SET username = 'geloescht-' || id, display_name = 'Gelöschter Benutzer', password_hash = '',
         status = 'deleted', avatar = NULL, status_text = '', is_owner = 0 WHERE id=?1",
        params![id],
    )?;
    tx.commit()?;
    Ok((avatar, files))
}

pub fn create_session(c: &Connection, user_id: i64, token_hash: &[u8], device: &str) -> ApiResult<()> {
    let now = now_ms();
    c.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, last_seen, device) VALUES (?1, ?2, ?3, ?3, ?4)",
        params![token_hash, user_id, now, device],
    )?;
    Ok(())
}

/// Resolves a session token hash to an active user and refreshes `last_seen`.
pub fn session_user(c: &Connection, token_hash: &[u8], max_age_ms: i64) -> ApiResult<Option<User>> {
    let now = now_ms();
    let uid: Option<i64> = c
        .query_row(
            "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.last_seen > ?2 AND u.status = 'active'",
            params![token_hash, now - max_age_ms],
            |r| r.get(0),
        )
        .optional()?;
    let Some(uid) = uid else { return Ok(None) };
    c.execute("UPDATE sessions SET last_seen=?2 WHERE token_hash=?1", params![token_hash, now])?;
    user_by_id(c, uid)
}

#[derive(Debug, Clone)]
pub struct SessionRow {
    pub token_hash: Vec<u8>,
    pub device: String,
    pub created_at: i64,
    pub last_seen: i64,
}

/// The sessions (signed-in devices) of a user, most recently used first.
pub fn user_sessions(c: &Connection, user_id: i64) -> ApiResult<Vec<SessionRow>> {
    let mut st = c.prepare("SELECT token_hash, device, created_at, last_seen FROM sessions WHERE user_id=?1 ORDER BY last_seen DESC")?;
    let rows = st.query_map(params![user_id], |r| Ok(SessionRow { token_hash: r.get(0)?, device: r.get(1)?, created_at: r.get(2)?, last_seen: r.get(3)? }))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn delete_session(c: &Connection, token_hash: &[u8]) -> ApiResult<()> {
    c.execute("DELETE FROM sessions WHERE token_hash=?1", params![token_hash])?;
    Ok(())
}

pub fn delete_user_sessions(c: &Connection, user_id: i64) -> ApiResult<()> {
    c.execute("DELETE FROM sessions WHERE user_id=?1", params![user_id])?;
    Ok(())
}

pub fn prune_sessions(c: &Connection, max_age_ms: i64) -> ApiResult<usize> {
    Ok(c.execute("DELETE FROM sessions WHERE last_seen < ?1", params![now_ms() - max_age_ms])?)
}

// ---------------------------------------------------------------------------
// Roles & permission cache
// ---------------------------------------------------------------------------

pub fn list_roles(c: &Connection) -> ApiResult<Vec<Role>> {
    let mut st =
        c.prepare("SELECT id, name, permissions, position, color, is_default FROM roles ORDER BY position DESC, id")?;
    let rows = st
        .query_map([], |r| {
            Ok(Role {
                id: r.get(0)?,
                name: r.get(1)?,
                permissions: r.get::<_, i64>(2)? as Perms,
                position: r.get(3)?,
                color: r.get(4)?,
                is_default: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn role_by_id(c: &Connection, id: i64) -> ApiResult<Option<Role>> {
    Ok(list_roles(c)?.into_iter().find(|r| r.id == id))
}

pub fn create_role(c: &Connection, name: &str, p: Perms, position: i64, color: &str, is_default: bool) -> ApiResult<i64> {
    c.execute(
        "INSERT INTO roles (name, permissions, position, color, is_default) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![name, p as i64, position, color, is_default],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn update_role(c: &Connection, r: &Role) -> ApiResult<()> {
    c.execute(
        "UPDATE roles SET name=?2, permissions=?3, position=?4, color=?5, is_default=?6 WHERE id=?1",
        params![r.id, r.name, r.permissions as i64, r.position, r.color, r.is_default],
    )?;
    Ok(())
}

pub fn delete_role(c: &Connection, id: i64) -> ApiResult<()> {
    c.execute("DELETE FROM roles WHERE id=?1", params![id])?;
    Ok(())
}

pub fn default_role_ids(c: &Connection) -> ApiResult<Vec<i64>> {
    let mut st = c.prepare("SELECT id FROM roles WHERE is_default=1")?;
    let rows = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<i64>, _>>()?;
    Ok(rows)
}

pub fn admin_role_id(c: &Connection) -> ApiResult<Option<i64>> {
    Ok(c.query_row(
        "SELECT id FROM roles WHERE (permissions & ?1) != 0 ORDER BY position DESC LIMIT 1",
        params![perms::ADMINISTRATOR as i64],
        |r| r.get(0),
    )
    .optional()?)
}

pub fn set_user_roles(c: &mut Connection, user_id: i64, roles: &[i64]) -> ApiResult<()> {
    let tx = c.transaction()?;
    tx.execute("DELETE FROM user_roles WHERE user_id=?1", params![user_id])?;
    for r in roles {
        tx.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?1, ?2)", params![user_id, r])?;
    }
    tx.commit()?;
    Ok(())
}

pub fn add_user_roles(c: &Connection, user_id: i64, roles: &[i64]) -> ApiResult<()> {
    for r in roles {
        c.execute("INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?1, ?2)", params![user_id, r])?;
    }
    Ok(())
}

pub fn load_perm_cache(c: &Connection) -> ApiResult<PermCache> {
    let mut pc = PermCache::default();
    for r in list_roles(c)? {
        pc.roles.insert(r.id, RoleInfo { perms: r.permissions, position: r.position });
    }
    {
        let mut st = c.prepare("SELECT ur.user_id, ur.role_id FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE u.status='active'")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            pc.user_roles.entry(r.get(0)?).or_default().push(r.get(1)?);
        }
    }
    {
        let mut st = c.prepare("SELECT id FROM users WHERE is_owner=1 AND status='active'")?;
        for id in st.query_map([], |r| r.get::<_, i64>(0))? {
            pc.owners.insert(id?);
        }
    }
    {
        let mut st = c.prepare("SELECT id, kind, slowmode, user_limit FROM channels")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            let kind: String = r.get(1)?;
            pc.channels.insert(
                r.get(0)?,
                ChannelInfo { is_dm: kind == "dm", voice: kind != "text", slowmode: r.get(2)?, user_limit: r.get(3)?, ..Default::default() },
            );
        }
    }
    {
        let mut st = c.prepare("SELECT id, timeout_until FROM users WHERE timeout_until > ?1 AND status='active'")?;
        let mut rows = st.query(params![now_ms()])?;
        while let Some(r) = rows.next()? {
            pc.timeouts.insert(r.get(0)?, r.get(1)?);
        }
    }
    {
        let mut st = c.prepare("SELECT channel_id, role_id, allow, deny FROM channel_overrides")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            if let Some(ch) = pc.channels.get_mut(&r.get(0)?) {
                ch.overrides.insert(r.get(1)?, (r.get::<_, i64>(2)? as Perms, r.get::<_, i64>(3)? as Perms));
            }
        }
    }
    {
        let mut st = c.prepare("SELECT channel_id, user_id FROM dm_members")?;
        let mut rows = st.query([])?;
        while let Some(r) = rows.next()? {
            if let Some(ch) = pc.channels.get_mut(&r.get(0)?) {
                ch.dm_members.push(r.get(1)?);
            }
        }
    }
    Ok(pc)
}

// ---------------------------------------------------------------------------
// Categories & channels
// ---------------------------------------------------------------------------

pub fn list_categories(c: &Connection) -> ApiResult<Vec<Category>> {
    let mut st = c.prepare("SELECT id, name, position FROM categories ORDER BY position, id")?;
    let rows = st
        .query_map([], |r| Ok(Category { id: r.get(0)?, name: r.get(1)?, position: r.get(2)? }))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn create_category(c: &Connection, name: &str) -> ApiResult<i64> {
    let pos: i64 = c.query_row("SELECT coalesce(max(position), -1) + 1 FROM categories", [], |r| r.get(0))?;
    c.execute("INSERT INTO categories (name, position) VALUES (?1, ?2)", params![name, pos])?;
    Ok(c.last_insert_rowid())
}

pub fn update_category(c: &Connection, id: i64, name: &str, position: i64) -> ApiResult<bool> {
    Ok(c.execute("UPDATE categories SET name=?2, position=?3 WHERE id=?1", params![id, name, position])? > 0)
}

pub fn delete_category(c: &Connection, id: i64) -> ApiResult<bool> {
    Ok(c.execute("DELETE FROM categories WHERE id=?1", params![id])? > 0)
}

const CHANNEL_SELECT: &str = "SELECT c.id, c.kind, c.name, c.topic, c.category_id, c.position,
    (SELECT max(m.id) FROM messages m WHERE m.channel_id = c.id), c.slowmode, c.user_limit FROM channels c";

fn row_channel(r: &Row) -> rusqlite::Result<Channel> {
    Ok(Channel {
        id: r.get(0)?,
        kind: r.get(1)?,
        name: r.get(2)?,
        topic: r.get(3)?,
        category_id: r.get(4)?,
        position: r.get(5)?,
        last_message_id: r.get(6)?,
        slowmode: r.get(7)?,
        user_limit: r.get(8)?,
    })
}

pub fn list_channels(c: &Connection) -> ApiResult<Vec<Channel>> {
    let mut st = c.prepare(&format!("{CHANNEL_SELECT} WHERE c.kind != 'dm' ORDER BY c.position, c.id"))?;
    let rows = st.query_map([], row_channel)?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn channel_by_id(c: &Connection, id: i64) -> ApiResult<Option<Channel>> {
    Ok(c.query_row(&format!("{CHANNEL_SELECT} WHERE c.id=?1"), params![id], row_channel).optional()?)
}

pub fn create_channel(c: &Connection, kind: &str, name: &str, topic: &str, category_id: Option<i64>) -> ApiResult<i64> {
    let pos: i64 = c.query_row(
        "SELECT coalesce(max(position), -1) + 1 FROM channels WHERE category_id IS ?1 AND kind != 'dm'",
        params![category_id],
        |r| r.get(0),
    )?;
    c.execute(
        "INSERT INTO channels (kind, name, topic, category_id, position, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![kind, name, topic, category_id, pos, now_ms()],
    )?;
    Ok(c.last_insert_rowid())
}

pub fn update_channel(c: &Connection, ch: &Channel) -> ApiResult<()> {
    c.execute(
        "UPDATE channels SET name=?2, topic=?3, category_id=?4, position=?5, slowmode=?6, user_limit=?7 WHERE id=?1 AND kind != 'dm'",
        params![ch.id, ch.name, ch.topic, ch.category_id, ch.position, ch.slowmode, ch.user_limit],
    )?;
    Ok(())
}

/// Deletes a channel and returns the attachment files that must be removed from disk.
pub fn delete_channel(c: &mut Connection, id: i64) -> ApiResult<Vec<String>> {
    let tx = c.transaction()?;
    let files = {
        let mut st = tx.prepare("SELECT id FROM attachments WHERE channel_id=?1")?;
        let v = st.query_map(params![id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        v
    };
    tx.execute("DELETE FROM attachments WHERE channel_id=?1", params![id])?;
    tx.execute("DELETE FROM mentions WHERE channel_id=?1", params![id])?;
    tx.execute("DELETE FROM channels WHERE id=?1", params![id])?;
    tx.commit()?;
    Ok(files)
}

pub fn list_overrides(c: &Connection, channel_id: i64) -> ApiResult<Vec<Override>> {
    let mut st = c.prepare("SELECT role_id, allow, deny FROM channel_overrides WHERE channel_id=?1")?;
    let rows = st
        .query_map(params![channel_id], |r| {
            Ok(Override { role_id: r.get(0)?, allow: r.get::<_, i64>(1)? as Perms, deny: r.get::<_, i64>(2)? as Perms })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn set_override(c: &Connection, channel_id: i64, role_id: i64, allow: Perms, deny: Perms) -> ApiResult<()> {
    if allow == 0 && deny == 0 {
        c.execute("DELETE FROM channel_overrides WHERE channel_id=?1 AND role_id=?2", params![channel_id, role_id])?;
    } else {
        c.execute(
            "INSERT INTO channel_overrides (channel_id, role_id, allow, deny) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(channel_id, role_id) DO UPDATE SET allow=excluded.allow, deny=excluded.deny",
            params![channel_id, role_id, allow as i64, deny as i64],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Direct messages
// ---------------------------------------------------------------------------

pub fn find_or_create_dm(c: &mut Connection, a: i64, b: i64) -> ApiResult<(i64, bool)> {
    if a == b {
        // Self-DM ("notes to self"): a dm channel with a single member.
        let existing: Option<i64> = c
            .query_row(
                "SELECT channel_id FROM dm_members GROUP BY channel_id HAVING count(*) = 1 AND max(user_id) = ?1",
                params![a],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Ok((id, false));
        }
        let tx = c.transaction()?;
        tx.execute("INSERT INTO channels (kind, name, created_at) VALUES ('dm', '', ?1)", params![now_ms()])?;
        let id = tx.last_insert_rowid();
        tx.execute("INSERT INTO dm_members (channel_id, user_id) VALUES (?1, ?2)", params![id, a])?;
        tx.commit()?;
        return Ok((id, true));
    }
    let existing: Option<i64> = c
        .query_row(
            "SELECT x.channel_id FROM dm_members x JOIN dm_members y ON x.channel_id = y.channel_id
             WHERE x.user_id = ?1 AND y.user_id = ?2",
            params![a, b],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(id) = existing {
        return Ok((id, false));
    }
    let tx = c.transaction()?;
    tx.execute("INSERT INTO channels (kind, name, created_at) VALUES ('dm', '', ?1)", params![now_ms()])?;
    let id = tx.last_insert_rowid();
    tx.execute("INSERT INTO dm_members (channel_id, user_id) VALUES (?1, ?2), (?1, ?3)", params![id, a, b])?;
    tx.commit()?;
    Ok((id, true))
}

pub fn list_dms(c: &Connection, user_id: i64) -> ApiResult<Vec<DmChannel>> {
    let mut st = c.prepare(
        "SELECT x.channel_id, y.user_id, (SELECT max(m.id) FROM messages m WHERE m.channel_id = x.channel_id),
                x.archived, x.pinned, x.cleared_before,
                CASE WHEN ux.read_receipts = 1 AND uy.read_receipts = 1
                     THEN coalesce((SELECT rs.last_read_id FROM read_states rs WHERE rs.user_id = y.user_id AND rs.channel_id = x.channel_id), 0) END
         FROM dm_members x JOIN dm_members y ON x.channel_id = y.channel_id AND y.user_id != x.user_id
         JOIN users ux ON ux.id = x.user_id JOIN users uy ON uy.id = y.user_id
         WHERE x.user_id = ?1
         UNION ALL
         SELECT d.channel_id, ?1, (SELECT max(m.id) FROM messages m WHERE m.channel_id = d.channel_id),
                d.archived, d.pinned, d.cleared_before, NULL
         FROM dm_members d
         WHERE d.user_id = ?1 AND d.channel_id IN (SELECT channel_id FROM dm_members GROUP BY channel_id HAVING count(*) = 1)",
    )?;
    let rows = st
        .query_map(params![user_id], |r| {
            Ok(DmChannel {
                channel_id: r.get(0)?,
                user_id: r.get(1)?,
                last_message_id: r.get(2)?,
                archived: r.get::<_, i64>(3)? != 0,
                pinned: r.get::<_, i64>(4)? != 0,
                cleared_before: r.get(5)?,
                peer_read: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Members of a DM channel (one for notes-to-self, two otherwise); empty if it is no DM.
pub fn dm_members(c: &Connection, channel_id: i64) -> ApiResult<Vec<i64>> {
    let mut st = c.prepare("SELECT user_id FROM dm_members WHERE channel_id=?1")?;
    let rows = st.query_map(params![channel_id], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Archive / pin a DM for one user. `None` leaves a flag unchanged.
pub fn set_dm_flags(c: &Connection, user_id: i64, channel_id: i64, archived: Option<bool>, pinned: Option<bool>) -> ApiResult<bool> {
    let n = c.execute(
        "UPDATE dm_members SET archived = coalesce(?3, archived), pinned = coalesce(?4, pinned) WHERE user_id=?1 AND channel_id=?2",
        params![user_id, channel_id, archived.map(i64::from), pinned.map(i64::from)],
    )?;
    Ok(n > 0)
}

/// "Delete chat for me": hides all current messages for this user and
/// unpins/unarchives the chat. Returns the new marker.
pub fn clear_dm(c: &Connection, user_id: i64, channel_id: i64) -> ApiResult<Option<i64>> {
    let last: i64 = c.query_row("SELECT coalesce(max(id), 0) FROM messages WHERE channel_id=?1", params![channel_id], |r| r.get(0))?;
    let n = c.execute(
        "UPDATE dm_members SET cleared_before = ?3, archived = 0, pinned = 0 WHERE user_id=?1 AND channel_id=?2",
        params![user_id, channel_id, last],
    )?;
    Ok((n > 0).then_some(last))
}

/// Messages up to this id are hidden for the user ("deleted for me"); 0 otherwise.
pub fn dm_cleared_before(c: &Connection, user_id: i64, channel_id: i64) -> ApiResult<i64> {
    Ok(c.query_row("SELECT cleared_before FROM dm_members WHERE user_id=?1 AND channel_id=?2", params![user_id, channel_id], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

/// All "deleted for me" markers of a user (channel → marker), for search.
pub fn dm_cleared_map(c: &Connection, user_id: i64) -> ApiResult<HashMap<i64, i64>> {
    let mut st = c.prepare("SELECT channel_id, cleared_before FROM dm_members WHERE user_id=?1 AND cleared_before > 0")?;
    let rows = st.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

pub fn read_receipts(c: &Connection, user_id: i64) -> ApiResult<bool> {
    Ok(c.query_row("SELECT read_receipts FROM users WHERE id=?1", params![user_id], |r| r.get::<_, i64>(0)).optional()?.unwrap_or(1) != 0)
}

pub fn set_read_receipts(c: &Connection, user_id: i64, on: bool) -> ApiResult<()> {
    c.execute("UPDATE users SET read_receipts=?2 WHERE id=?1", params![user_id, i64::from(on)])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// An end-to-end encrypted reply preview is passed on whole: the client cannot
// decrypt a cut-off envelope.
const MSG_SELECT: &str = "SELECT m.id, m.channel_id, m.author_id, m.content, m.reply_to, m.created_at, m.edited_at,
    r.id, r.author_id, CASE WHEN r.content LIKE 'nxe1.%' THEN r.content ELSE substr(r.content, 1, 160) END, m.pinned_at, m.forwarded_from
    FROM messages m LEFT JOIN messages r ON r.id = m.reply_to";

fn row_message(r: &Row) -> rusqlite::Result<Message> {
    let rid: Option<i64> = r.get(7)?;
    Ok(Message {
        id: r.get(0)?,
        channel_id: r.get(1)?,
        author_id: r.get(2)?,
        content: r.get(3)?,
        reply_to: r.get(4)?,
        created_at: r.get(5)?,
        edited_at: r.get(6)?,
        reply_preview: match rid {
            Some(id) => Some(ReplyPreview { id, author_id: r.get(8)?, content: r.get(9)? }),
            None => None,
        },
        forwarded_from: r.get(11)?,
        poll: None,
        mentions: Vec::new(),
        attachments: Vec::new(),
        reactions: Vec::new(),
        pinned_at: r.get(10)?,
    })
}

fn placeholders(n: usize) -> String {
    vec!["?"; n].join(",")
}

/// Loads mentions and attachments for a batch of messages.
fn hydrate(c: &Connection, msgs: &mut [Message]) -> ApiResult<()> {
    if msgs.is_empty() {
        return Ok(());
    }
    let ids: Vec<i64> = msgs.iter().map(|m| m.id).collect();
    let idx: HashMap<i64, usize> = ids.iter().enumerate().map(|(i, id)| (*id, i)).collect();
    let ph = placeholders(ids.len());
    {
        let mut st = c.prepare(&format!("SELECT message_id, user_id FROM mentions WHERE message_id IN ({ph})"))?;
        let mut rows = st.query(rusqlite::params_from_iter(ids.iter()))?;
        while let Some(r) = rows.next()? {
            if let Some(i) = idx.get(&r.get::<_, i64>(0)?) {
                msgs[*i].mentions.push(r.get(1)?);
            }
        }
    }
    {
        let mut st = c.prepare(&format!(
            "SELECT message_id, id, filename, size, mime FROM attachments WHERE message_id IN ({ph}) ORDER BY created_at"
        ))?;
        let mut rows = st.query(rusqlite::params_from_iter(ids.iter()))?;
        while let Some(r) = rows.next()? {
            if let Some(i) = idx.get(&r.get::<_, i64>(0)?) {
                msgs[*i].attachments.push(Attachment {
                    id: r.get(1)?,
                    filename: r.get(2)?,
                    size: r.get(3)?,
                    mime: r.get(4)?,
                });
            }
        }
    }
    {
        let mut st = c.prepare(&format!(
            "SELECT message_id, emoji, user_id FROM reactions WHERE message_id IN ({ph}) ORDER BY created_at, emoji"
        ))?;
        let mut rows = st.query(rusqlite::params_from_iter(ids.iter()))?;
        while let Some(r) = rows.next()? {
            if let Some(i) = idx.get(&r.get::<_, i64>(0)?) {
                let emoji: String = r.get(1)?;
                let uid: i64 = r.get(2)?;
                let list = &mut msgs[*i].reactions;
                match list.iter_mut().find(|x| x.emoji == emoji) {
                    Some(x) => x.users.push(uid),
                    None => list.push(Reaction { emoji, users: vec![uid] }),
                }
            }
        }
    }
    {
        let mut st = c.prepare(&format!("SELECT message_id, question, options, multi, ends_at FROM polls WHERE message_id IN ({ph})"))?;
        let mut rows = st.query(rusqlite::params_from_iter(ids.iter()))?;
        while let Some(r) = rows.next()? {
            if let Some(i) = idx.get(&r.get::<_, i64>(0)?) {
                let texts: Vec<String> = serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or_default();
                msgs[*i].poll = Some(Poll {
                    question: r.get(1)?,
                    options: texts.into_iter().map(|text| PollOption { text, voters: Vec::new() }).collect(),
                    multi: r.get(3)?,
                    ends_at: r.get(4)?,
                });
            }
        }
    }
    if msgs.iter().any(|m| m.poll.is_some()) {
        let mut st = c.prepare(&format!("SELECT message_id, user_id, option FROM poll_votes WHERE message_id IN ({ph}) ORDER BY rowid"))?;
        let mut rows = st.query(rusqlite::params_from_iter(ids.iter()))?;
        while let Some(r) = rows.next()? {
            if let Some(i) = idx.get(&r.get::<_, i64>(0)?) {
                let opt: usize = r.get::<_, i64>(2)? as usize;
                if let Some(o) = msgs[*i].poll.as_mut().and_then(|p| p.options.get_mut(opt)) {
                    o.voters.push(r.get(1)?);
                }
            }
        }
    }
    Ok(())
}

pub const MAX_POLL_OPTIONS: usize = 10;

/// Creates a message carrying a poll.
pub fn insert_poll(
    c: &mut Connection,
    channel_id: i64,
    author_id: i64,
    question: &str,
    options: &[String],
    multi: bool,
    ends_at: Option<i64>,
) -> ApiResult<Message> {
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO messages (channel_id, author_id, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![channel_id, author_id, question, now_ms()],
    )?;
    let id = tx.last_insert_rowid();
    let opts = serde_json::to_string(options).map_err(|_| ApiError::internal())?;
    tx.execute(
        "INSERT INTO polls (message_id, question, options, multi, ends_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, question, opts, multi, ends_at],
    )?;
    tx.commit()?;
    get_message(c, id)?.ok_or_else(ApiError::internal)
}

/// Replaces a member's votes in a poll.
pub fn vote_poll(c: &mut Connection, message_id: i64, user_id: i64, options: &[usize]) -> ApiResult<()> {
    let tx = c.transaction()?;
    tx.execute("DELETE FROM poll_votes WHERE message_id=?1 AND user_id=?2", params![message_id, user_id])?;
    for o in options {
        tx.execute(
            "INSERT OR IGNORE INTO poll_votes (message_id, user_id, option) VALUES (?1, ?2, ?3)",
            params![message_id, user_id, *o as i64],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn end_poll(c: &Connection, message_id: i64) -> ApiResult<()> {
    c.execute("UPDATE polls SET ends_at=?2 WHERE message_id=?1", params![message_id, now_ms()])?;
    Ok(())
}

/// Copies a message into another channel; `new_ids` are the already copied
/// attachment files (same order as `src.attachments`).
pub fn forward_message(c: &mut Connection, src: &Message, channel_id: i64, user_id: i64, new_ids: &[String]) -> ApiResult<Message> {
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO messages (channel_id, author_id, content, created_at, forwarded_from) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![channel_id, user_id, src.content, now_ms(), src.forwarded_from.unwrap_or(src.author_id)],
    )?;
    let id = tx.last_insert_rowid();
    for (a, new_id) in src.attachments.iter().zip(new_ids) {
        tx.execute(
            "INSERT INTO attachments (id, message_id, channel_id, uploader_id, filename, size, mime, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![new_id, id, channel_id, user_id, a.filename, a.size, a.mime, now_ms()],
        )?;
    }
    tx.commit()?;
    get_message(c, id)?.ok_or_else(ApiError::internal)
}

/// Maximum distinct reactions per message.
pub const MAX_REACTIONS: i64 = 20;

/// Adds or removes a reaction. Returns false if nothing changed.
pub fn set_reaction(c: &Connection, message_id: i64, user_id: i64, emoji: &str, add: bool) -> ApiResult<bool> {
    if add {
        let distinct: i64 = c.query_row(
            "SELECT count(DISTINCT emoji) FROM reactions WHERE message_id=?1 AND emoji != ?2",
            params![message_id, emoji],
            |r| r.get(0),
        )?;
        if distinct >= MAX_REACTIONS {
            return Err(ApiError::invalid(format!("Höchstens {MAX_REACTIONS} verschiedene Reaktionen pro Nachricht")));
        }
        Ok(c.execute(
            "INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![message_id, user_id, emoji, now_ms()],
        )? > 0)
    } else {
        Ok(c.execute(
            "DELETE FROM reactions WHERE message_id=?1 AND user_id=?2 AND emoji=?3",
            params![message_id, user_id, emoji],
        )? > 0)
    }
}

pub fn set_pinned(c: &Connection, message_id: i64, pinned: bool) -> ApiResult<()> {
    c.execute(
        "UPDATE messages SET pinned_at = ?2 WHERE id=?1",
        params![message_id, if pinned { Some(now_ms()) } else { None }],
    )?;
    Ok(())
}

pub fn pinned_messages(c: &Connection, channel_id: i64) -> ApiResult<Vec<Message>> {
    let mut st = c.prepare(&format!(
        "{MSG_SELECT} WHERE m.channel_id=?1 AND m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC LIMIT 50"
    ))?;
    let mut msgs = st.query_map(params![channel_id], row_message)?.collect::<Result<Vec<_>, _>>()?;
    hydrate(c, &mut msgs)?;
    Ok(msgs)
}

pub fn get_message(c: &Connection, id: i64) -> ApiResult<Option<Message>> {
    let m = c.query_row(&format!("{MSG_SELECT} WHERE m.id=?1"), params![id], row_message).optional()?;
    match m {
        Some(m) => {
            let mut v = [m];
            hydrate(c, &mut v)?;
            let [m] = v;
            Ok(Some(m))
        }
        None => Ok(None),
    }
}

pub fn insert_message(
    c: &mut Connection,
    channel_id: i64,
    author_id: i64,
    content: &str,
    reply_to: Option<i64>,
    mentions: &[i64],
    attachment_ids: &[String],
) -> ApiResult<Message> {
    let tx = c.transaction()?;
    let reply_to = match reply_to {
        Some(r) => tx
            .query_row("SELECT id FROM messages WHERE id=?1 AND channel_id=?2", params![r, channel_id], |r| r.get::<_, i64>(0))
            .optional()?,
        None => None,
    };
    tx.execute(
        "INSERT INTO messages (channel_id, author_id, content, reply_to, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![channel_id, author_id, content, reply_to, now_ms()],
    )?;
    let id = tx.last_insert_rowid();
    for u in mentions {
        tx.execute(
            "INSERT OR IGNORE INTO mentions (message_id, user_id, channel_id) VALUES (?1, ?2, ?3)",
            params![id, u, channel_id],
        )?;
    }
    for a in attachment_ids {
        let n = tx.execute(
            "UPDATE attachments SET message_id=?1 WHERE id=?2 AND uploader_id=?3 AND channel_id=?4 AND message_id IS NULL",
            params![id, a, author_id, channel_id],
        )?;
        if n == 0 {
            return Err(ApiError::invalid("Anhang ist ungültig oder bereits verwendet"));
        }
    }
    tx.commit()?;
    get_message(c, id)?.ok_or_else(ApiError::internal)
}

pub fn edit_message(c: &mut Connection, id: i64, content: &str, mentions: &[i64]) -> ApiResult<Message> {
    let tx = c.transaction()?;
    let channel_id: i64 = tx.query_row("SELECT channel_id FROM messages WHERE id=?1", params![id], |r| r.get(0))?;
    tx.execute("UPDATE messages SET content=?2, edited_at=?3 WHERE id=?1", params![id, content, now_ms()])?;
    tx.execute("DELETE FROM mentions WHERE message_id=?1", params![id])?;
    for u in mentions {
        tx.execute(
            "INSERT OR IGNORE INTO mentions (message_id, user_id, channel_id) VALUES (?1, ?2, ?3)",
            params![id, u, channel_id],
        )?;
    }
    tx.commit()?;
    get_message(c, id)?.ok_or_else(ApiError::internal)
}

/// Deletes a message; returns attachment ids whose files must be removed.
pub fn delete_message(c: &mut Connection, id: i64) -> ApiResult<Vec<String>> {
    let tx = c.transaction()?;
    let files = {
        let mut st = tx.prepare("SELECT id FROM attachments WHERE message_id=?1")?;
        let v = st.query_map(params![id], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        v
    };
    tx.execute("DELETE FROM attachments WHERE message_id=?1", params![id])?;
    tx.execute("DELETE FROM messages WHERE id=?1", params![id])?;
    tx.commit()?;
    Ok(files)
}

/// Newest `limit` messages before `before` (exclusive), returned oldest first.
pub fn history(c: &Connection, channel_id: i64, before: Option<i64>, limit: usize) -> ApiResult<Vec<Message>> {
    let mut st = c.prepare(&format!("{MSG_SELECT} WHERE m.channel_id=?1 AND m.id < ?2 ORDER BY m.id DESC LIMIT ?3"))?;
    let mut msgs = st
        .query_map(params![channel_id, before.unwrap_or(i64::MAX), limit as i64], row_message)?
        .collect::<Result<Vec<_>, _>>()?;
    msgs.reverse();
    hydrate(c, &mut msgs)?;
    Ok(msgs)
}

/// Oldest `limit` messages after `after` (exclusive), oldest first. Used to
/// page forward when jumping to a search result.
pub fn history_after(c: &Connection, channel_id: i64, after: i64, limit: usize) -> ApiResult<Vec<Message>> {
    let mut st = c.prepare(&format!("{MSG_SELECT} WHERE m.channel_id=?1 AND m.id > ?2 ORDER BY m.id ASC LIMIT ?3"))?;
    let mut msgs = st.query_map(params![channel_id, after, limit as i64], row_message)?.collect::<Result<Vec<_>, _>>()?;
    hydrate(c, &mut msgs)?;
    Ok(msgs)
}

/// Turns user input into a safe FTS5 query: every word becomes a quoted prefix term.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect::<String>())
        .filter(|w| !w.is_empty())
        .take(8)
        .map(|w| format!("\"{w}\"*"))
        .collect();
    if terms.is_empty() { None } else { Some(terms.join(" ")) }
}

pub fn search(c: &Connection, query: &str, channel_ids: &[i64], limit: usize) -> ApiResult<Vec<Message>> {
    let Some(q) = fts_query(query) else { return Ok(Vec::new()) };
    if channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "{MSG_SELECT} WHERE m.id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?1)
         AND m.channel_id IN ({}) ORDER BY m.id DESC LIMIT {}",
        placeholders(channel_ids.len()),
        limit
    );
    let mut st = c.prepare(&sql)?;
    let mut args: Vec<rusqlite::types::Value> = vec![q.into()];
    args.extend(channel_ids.iter().map(|i| rusqlite::types::Value::Integer(*i)));
    let mut msgs = st.query_map(rusqlite::params_from_iter(args), row_message)?.collect::<Result<Vec<_>, _>>()?;
    hydrate(c, &mut msgs)?;
    Ok(msgs)
}

/// Deletes messages older than `cutoff_ms`. Returns (count, attachment files).
pub fn purge_messages_before(c: &mut Connection, cutoff_ms: i64) -> ApiResult<(usize, Vec<String>)> {
    let tx = c.transaction()?;
    let files = {
        let mut st = tx.prepare(
            "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.created_at < ?1",
        )?;
        let v = st.query_map(params![cutoff_ms], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
        v
    };
    tx.execute(
        "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?1)",
        params![cutoff_ms],
    )?;
    let n = tx.execute("DELETE FROM messages WHERE created_at < ?1", params![cutoff_ms])?;
    tx.commit()?;
    Ok((n, files))
}

pub fn count_messages(c: &Connection) -> ApiResult<i64> {
    Ok(c.query_row("SELECT count(*) FROM messages", [], |r| r.get(0))?)
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

pub fn insert_attachment(
    c: &Connection,
    id: &str,
    channel_id: i64,
    uploader_id: i64,
    filename: &str,
    size: i64,
    mime: &str,
) -> ApiResult<()> {
    c.execute(
        "INSERT INTO attachments (id, channel_id, uploader_id, filename, size, mime, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, channel_id, uploader_id, filename, size, mime, now_ms()],
    )?;
    Ok(())
}

/// Returns (attachment, channel_id, bound_to_message).
pub fn get_attachment(c: &Connection, id: &str) -> ApiResult<Option<(Attachment, i64, Option<i64>, i64)>> {
    Ok(c.query_row(
        "SELECT id, filename, size, mime, channel_id, message_id, uploader_id FROM attachments WHERE id=?1",
        params![id],
        |r| {
            Ok((
                Attachment { id: r.get(0)?, filename: r.get(1)?, size: r.get(2)?, mime: r.get(3)? },
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
            ))
        },
    )
    .optional()?)
}

pub fn storage_used(c: &Connection) -> ApiResult<i64> {
    Ok(c.query_row("SELECT coalesce(sum(size), 0) FROM attachments", [], |r| r.get(0))?)
}

/// Removes uploads that were never attached to a message.
pub fn take_stale_uploads(c: &Connection, older_than_ms: i64) -> ApiResult<Vec<String>> {
    let cutoff = now_ms() - older_than_ms;
    let mut st = c.prepare("SELECT id FROM attachments WHERE message_id IS NULL AND created_at < ?1")?;
    let ids = st.query_map(params![cutoff], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
    c.execute("DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?1", params![cutoff])?;
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Read states & mentions
// ---------------------------------------------------------------------------

pub fn set_read(c: &Connection, user_id: i64, channel_id: i64, message_id: i64) -> ApiResult<()> {
    c.execute(
        "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = max(last_read_id, excluded.last_read_id)",
        params![user_id, channel_id, message_id],
    )?;
    Ok(())
}

/// Sets the read marker exactly (used for "mark as unread").
pub fn set_read_exact(c: &Connection, user_id: i64, channel_id: i64, message_id: i64) -> ApiResult<()> {
    c.execute(
        "INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?1, ?2, ?3)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id",
        params![user_id, channel_id, message_id],
    )?;
    Ok(())
}

pub fn read_states(c: &Connection, user_id: i64) -> ApiResult<HashMap<i64, i64>> {
    let mut st = c.prepare("SELECT channel_id, last_read_id FROM read_states WHERE user_id=?1")?;
    let rows = st.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

/// Unread mentions per channel.
pub fn mention_counts(c: &Connection, user_id: i64) -> ApiResult<HashMap<i64, i64>> {
    let mut st = c.prepare(
        "SELECT mn.channel_id, count(*) FROM mentions mn
         LEFT JOIN read_states rs ON rs.user_id = mn.user_id AND rs.channel_id = mn.channel_id
         WHERE mn.user_id = ?1 AND mn.message_id > coalesce(rs.last_read_id, 0)
         GROUP BY mn.channel_id",
    )?;
    let rows = st.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<HashMap<_, _>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

pub fn create_invite(
    c: &Connection,
    code: &str,
    created_by: Option<i64>,
    expires_at: Option<i64>,
    max_uses: Option<i64>,
    role_id: Option<i64>,
    owner_setup: bool,
) -> ApiResult<()> {
    c.execute(
        "INSERT INTO invites (code, created_by, created_at, expires_at, max_uses, role_id, owner_setup)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![code, created_by, now_ms(), expires_at, max_uses, role_id, owner_setup],
    )?;
    Ok(())
}

pub fn list_invites(c: &Connection) -> ApiResult<Vec<Invite>> {
    let mut st = c.prepare(
        "SELECT code, created_by, created_at, expires_at, max_uses, uses, role_id FROM invites
         WHERE owner_setup = 0 ORDER BY created_at DESC",
    )?;
    let rows = st
        .query_map([], |r| {
            Ok(Invite {
                code: r.get(0)?,
                created_by: r.get(1)?,
                created_at: r.get(2)?,
                expires_at: r.get(3)?,
                max_uses: r.get(4)?,
                uses: r.get(5)?,
                role_id: r.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn delete_invite(c: &Connection, code: &str) -> ApiResult<bool> {
    Ok(c.execute("DELETE FROM invites WHERE code=?1", params![code])? > 0)
}

pub enum InviteUse {
    Normal { role_id: Option<i64> },
    OwnerSetup,
}

/// Validates and consumes one use of an invite inside the caller's transaction.
pub fn consume_invite(c: &Connection, code: &str) -> ApiResult<InviteUse> {
    let row: Option<(Option<i64>, Option<i64>, i64, Option<i64>, bool)> = c
        .query_row(
            "SELECT expires_at, max_uses, uses, role_id, owner_setup FROM invites WHERE code=?1",
            params![code.trim().to_ascii_uppercase()],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?;
    let Some((expires, max_uses, uses, role_id, owner)) = row else {
        return Err(ApiError::new(Code::InvalidInvite, "Einladung ist ungültig"));
    };
    if expires.is_some_and(|e| e < now_ms()) || max_uses.is_some_and(|m| uses >= m) {
        return Err(ApiError::new(Code::InvalidInvite, "Einladung ist abgelaufen"));
    }
    let code = code.trim().to_ascii_uppercase();
    if owner {
        c.execute("DELETE FROM invites WHERE code=?1", params![code])?;
        return Ok(InviteUse::OwnerSetup);
    }
    c.execute("UPDATE invites SET uses = uses + 1 WHERE code=?1", params![code])?;
    Ok(InviteUse::Normal { role_id })
}

pub fn owner_setup_code(c: &Connection) -> ApiResult<Option<String>> {
    Ok(c.query_row("SELECT code FROM invites WHERE owner_setup=1 LIMIT 1", [], |r| r.get(0)).optional()?)
}

pub fn prune_invites(c: &Connection) -> ApiResult<usize> {
    Ok(c.execute(
        "DELETE FROM invites WHERE owner_setup=0 AND ((expires_at IS NOT NULL AND expires_at < ?1)
         OR (max_uses IS NOT NULL AND uses >= max_uses))",
        params![now_ms()],
    )?)
}

// ---------------------------------------------------------------------------
// Relationships (friends / blocks)
// ---------------------------------------------------------------------------

pub fn relationships(c: &Connection, user_id: i64) -> ApiResult<Vec<(i64, String)>> {
    let mut st = c.prepare("SELECT target_id, kind FROM relationships WHERE user_id=?1")?;
    let rows = st.query_map(params![user_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn relationship(c: &Connection, user_id: i64, target: i64) -> ApiResult<Option<String>> {
    Ok(c.query_row(
        "SELECT kind FROM relationships WHERE user_id=?1 AND target_id=?2",
        params![user_id, target],
        |r| r.get(0),
    )
    .optional()?)
}

pub fn set_relationship(c: &Connection, user_id: i64, target: i64, kind: Option<&str>) -> ApiResult<()> {
    match kind {
        Some(k) => c.execute(
            "INSERT INTO relationships (user_id, target_id, kind) VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id, target_id) DO UPDATE SET kind = excluded.kind",
            params![user_id, target, k],
        )?,
        None => c.execute("DELETE FROM relationships WHERE user_id=?1 AND target_id=?2", params![user_id, target])?,
    };
    Ok(())
}

pub fn is_blocked_either(c: &Connection, a: i64, b: i64) -> ApiResult<bool> {
    let n: i64 = c.query_row(
        "SELECT count(*) FROM relationships WHERE kind='blocked' AND ((user_id=?1 AND target_id=?2) OR (user_id=?2 AND target_id=?1))",
        params![a, b],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

// ---------------------------------------------------------------------------
// End-to-end encryption: public keys
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct E2eKey {
    pub user_id: i64,
    pub kid: String,
    pub key: String,
    pub created_at: i64,
}

/// Stores a public key; returns false if it was already known. Only the
/// newest `keep` keys per user are kept.
pub fn e2e_add_key(c: &Connection, uid: i64, kid: &str, key: &str, keep: i64) -> ApiResult<bool> {
    let n = c.execute(
        "INSERT OR IGNORE INTO e2e_keys (user_id, kid, public_key, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![uid, kid, key, now_ms()],
    )?;
    c.execute(
        "DELETE FROM e2e_keys WHERE user_id=?1 AND kid NOT IN (SELECT kid FROM e2e_keys WHERE user_id=?1 ORDER BY created_at DESC, kid LIMIT ?2)",
        params![uid, keep],
    )?;
    Ok(n > 0)
}

pub fn e2e_keys(c: &Connection, uids: &[i64]) -> ApiResult<Vec<E2eKey>> {
    let mut out = Vec::new();
    let mut st = c.prepare("SELECT kid, public_key, created_at FROM e2e_keys WHERE user_id=?1 ORDER BY created_at DESC, kid")?;
    for &uid in uids {
        let rows = st.query_map(params![uid], |r| Ok(E2eKey { user_id: uid, kid: r.get(0)?, key: r.get(1)?, created_at: r.get(2)? }))?;
        for k in rows {
            out.push(k?);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

pub fn audit(c: &Connection, actor: Option<i64>, action: &str, target: &str, detail: &str) {
    if let Err(e) = c.execute(
        "INSERT INTO audit_log (ts, actor_id, action, target, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now_ms(), actor, action, target, detail],
    ) {
        tracing::error!(error = %e, "failed to write audit log");
    }
}

pub fn list_audit(c: &Connection, before: Option<i64>, limit: usize) -> ApiResult<Vec<AuditEntry>> {
    let mut st = c.prepare(
        "SELECT id, ts, actor_id, action, target, detail FROM audit_log WHERE id < ?1 ORDER BY id DESC LIMIT ?2",
    )?;
    let rows = st
        .query_map(params![before.unwrap_or(i64::MAX), limit as i64], |r| {
            Ok(AuditEntry {
                id: r.get(0)?,
                ts: r.get(1)?,
                actor_id: r.get(2)?,
                action: r.get(3)?,
                target: r.get(4)?,
                detail: r.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn prune_audit(c: &Connection, keep: i64) -> ApiResult<()> {
    c.execute("DELETE FROM audit_log WHERE id <= (SELECT max(id) FROM audit_log) - ?1", params![keep])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn setup() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| init_defaults(c).unwrap());
        db
    }

    #[test]
    fn defaults_created_once() {
        let db = setup();
        db.with(|c| {
            assert!(!init_defaults(c).unwrap());
            assert_eq!(list_roles(c).unwrap().len(), 4);
            assert_eq!(list_channels(c).unwrap().len(), 2);
            assert_eq!(get_settings(c).unwrap().registration_mode, RegistrationMode::Invite);
        });
    }

    #[test]
    fn users_unique_case_insensitive() {
        let db = setup();
        db.with(|c| {
            create_user(c, "Anna", "h", "active", false).unwrap();
            let e = create_user(c, "anna", "h", "active", false).unwrap_err();
            assert_eq!(e.code, Code::UsernameTaken);
            assert!(user_by_name(c, "ANNA").unwrap().is_some());
        });
    }

    #[test]
    fn message_lifecycle_and_history_paging() {
        let db = setup();
        db.with(|c| {
            let u = create_user(c, "anna", "h", "active", false).unwrap();
            let b = create_user(c, "ben", "h", "active", false).unwrap();
            let ch = list_channels(c).unwrap()[0].id;
            let mut ids = Vec::new();
            for i in 0..30 {
                ids.push(insert_message(c, ch, u, &format!("Nachricht {i}"), None, &[], &[]).unwrap().id);
            }
            let reply = insert_message(c, ch, b, "Antwort @anna", Some(ids[0]), &[u], &[]).unwrap();
            assert_eq!(reply.reply_preview.as_ref().unwrap().id, ids[0]);
            assert_eq!(reply.mentions, vec![u]);

            let page = history(c, ch, None, 10).unwrap();
            assert_eq!(page.len(), 10);
            assert_eq!(page.last().unwrap().id, reply.id);
            assert!(page.windows(2).all(|w| w[0].id < w[1].id), "ascending order");
            let older = history(c, ch, Some(page[0].id), 100).unwrap();
            assert_eq!(older.len(), 21);

            let edited = edit_message(c, ids[1], "geändert", &[]).unwrap();
            assert!(edited.edited_at.is_some());
            delete_message(c, ids[2]).unwrap();
            assert!(get_message(c, ids[2]).unwrap().is_none());

            assert_eq!(mention_counts(c, u).unwrap().get(&ch), Some(&1));
            set_read(c, u, ch, reply.id).unwrap();
            assert!(mention_counts(c, u).unwrap().is_empty());
        });
    }

    #[test]
    fn search_is_scoped_and_injection_safe() {
        let db = setup();
        db.with(|c| {
            let u = create_user(c, "anna", "h", "active", false).unwrap();
            let chans = list_channels(c).unwrap();
            let (a, b) = (chans[0].id, chans[1].id);
            insert_message(c, a, u, "Das Treffen ist morgen", None, &[], &[]).unwrap();
            insert_message(c, b, u, "Geheimes Treffen", None, &[], &[]).unwrap();
            assert_eq!(search(c, "treff", &[a], 50).unwrap().len(), 1);
            assert_eq!(search(c, "treffen", &[a, b], 50).unwrap().len(), 2);
            assert!(search(c, "\" OR 1=1 --", &[a], 50).unwrap().is_empty());
            assert!(search(c, "NEAR(", &[a], 50).is_ok());
        });
    }

    #[test]
    fn invites_expire_and_count_uses() {
        let db = setup();
        db.with(|c| {
            create_invite(c, "ABC", None, None, Some(1), None, false).unwrap();
            assert!(matches!(consume_invite(c, "abc").unwrap(), InviteUse::Normal { .. }));
            assert_eq!(consume_invite(c, "ABC").err().unwrap().code, Code::InvalidInvite);
            create_invite(c, "OLD", None, Some(1), None, None, false).unwrap();
            assert!(consume_invite(c, "OLD").is_err());
            create_invite(c, "OWN", None, None, None, None, true).unwrap();
            assert!(matches!(consume_invite(c, "OWN").unwrap(), InviteUse::OwnerSetup));
            assert!(consume_invite(c, "OWN").is_err(), "owner code is single use");
        });
    }

    #[test]
    fn attachments_bind_only_once_and_only_by_uploader() {
        let db = setup();
        db.with(|c| {
            let u = create_user(c, "anna", "h", "active", false).unwrap();
            let x = create_user(c, "mallory", "h", "active", false).unwrap();
            let ch = list_channels(c).unwrap()[0].id;
            insert_attachment(c, "f1", ch, u, "a.txt", 3, "application/octet-stream").unwrap();
            assert!(insert_message(c, ch, x, "steal", None, &[], &["f1".into()]).is_err());
            let m = insert_message(c, ch, u, "file", None, &[], &["f1".into()]).unwrap();
            assert_eq!(m.attachments.len(), 1);
            assert!(insert_message(c, ch, u, "again", None, &[], &["f1".into()]).is_err());
            assert_eq!(delete_message(c, m.id).unwrap(), vec!["f1".to_string()]);
            assert_eq!(storage_used(c).unwrap(), 0);
        });
    }

    #[test]
    fn dms_are_reused() {
        let db = setup();
        db.with(|c| {
            let a = create_user(c, "anna", "h", "active", false).unwrap();
            let b = create_user(c, "ben", "h", "active", false).unwrap();
            let (id1, new1) = find_or_create_dm(c, a, b).unwrap();
            let (id2, new2) = find_or_create_dm(c, b, a).unwrap();
            assert!(new1 && !new2);
            assert_eq!(id1, id2);
            assert_eq!(list_dms(c, a).unwrap()[0].user_id, b);
            let pc = load_perm_cache(c).unwrap();
            assert!(pc.has_in(a, id1, perms::SEND_MESSAGES));
        });
    }

    #[test]
    fn delete_user_leaves_tombstone() {
        let db = setup();
        db.with(|c| {
            let a = create_user(c, "anna", "h", "active", false).unwrap();
            let ch = list_channels(c).unwrap()[0].id;
            let m = insert_message(c, ch, a, "hallo", None, &[], &[]).unwrap();
            delete_user(c, a, false).unwrap();
            assert!(user_by_name(c, "anna").unwrap().is_none());
            assert!(get_message(c, m.id).unwrap().is_some());
            assert_eq!(user_by_id(c, a).unwrap().unwrap().status, "deleted");
            create_user(c, "anna", "h", "active", false).unwrap();
        });
    }

    #[test]
    fn retention_purge() {
        let db = setup();
        db.with(|c| {
            let a = create_user(c, "anna", "h", "active", false).unwrap();
            let ch = list_channels(c).unwrap()[0].id;
            insert_message(c, ch, a, "alt", None, &[], &[]).unwrap();
            c.execute("UPDATE messages SET created_at = 1", []).unwrap();
            insert_message(c, ch, a, "neu", None, &[], &[]).unwrap();
            let (n, _) = purge_messages_before(c, now_ms() - 1000).unwrap();
            assert_eq!(n, 1);
            assert_eq!(count_messages(c).unwrap(), 1);
        });
    }
}

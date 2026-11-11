//! Profile, presence, password, direct messages, friends and blocking.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult, Code};
use crate::util::{clean_text, validate_password};
use crate::ws::{broadcast_presence, member_json, parse, Ctx};
use crate::{auth, files, hub, ops_voice, store};

#[derive(Deserialize)]
struct ProfileReq {
    display_name: Option<String>,
    status_text: Option<String>,
    bio: Option<String>,
    banner: Option<String>,
}

/// Banner: empty or one/two "#rrggbb" colors separated by a comma.
pub fn valid_banner(b: &str) -> bool {
    b.is_empty()
        || (b.split(',').count() <= 2
            && b.split(',').all(|c| c.len() == 7 && c.starts_with('#') && c[1..].bytes().all(|x| x.is_ascii_hexdigit())))
}

pub async fn profile_update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ProfileReq = parse(d)?;
    let uid = ctx.uid;
    let user = ctx.st.db.call(move |c| store::user_by_id(c, uid)).await?.ok_or_else(ApiError::internal)?;
    let display = match r.display_name {
        Some(s) => clean_text(&s, 32, false, "Anzeigename")?,
        None => user.display_name.clone(),
    };
    let status = match r.status_text {
        Some(s) => clean_text(&s, 128, false, "Statusmeldung")?,
        None => user.status_text.clone(),
    };
    let bio = match r.bio {
        Some(s) => clean_text(&s, 190, true, "Über mich")?,
        None => user.bio.clone(),
    };
    let banner = match r.banner {
        Some(b) if valid_banner(&b) => b.to_ascii_lowercase(),
        Some(_) => return Err(ApiError::invalid("Banner: ungültige Farbe")),
        None => user.banner.clone(),
    };
    let u = ctx
        .st
        .db
        .call(move |c| {
            store::update_profile(c, uid, &display, &status)?;
            store::set_bio_banner(c, uid, &bio, &banner)?;
            store::user_by_id(c, uid)
        })
        .await?
        .ok_or_else(ApiError::internal)?;
    broadcast_member(&ctx.st, &u);
    Ok(json!(u))
}

pub fn broadcast_member(st: &crate::AppState, u: &store::User) {
    let pc = st.perms();
    let ev = hub::event("member.updated", &member_json(st, &pc, u));
    st.hub.broadcast(&ev, |_| true);
}

#[derive(Deserialize)]
struct PresenceReq {
    presence: String,
}

pub async fn presence(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: PresenceReq = parse(d)?;
    if !["online", "idle", "dnd", "invisible"].contains(&r.presence.as_str()) {
        return Err(ApiError::invalid("Unbekannter Status"));
    }
    let uid = ctx.uid;
    let p = r.presence.clone();
    // "idle" is set automatically by the client and not persisted as preference.
    if p != "idle" {
        ctx.st.db.call(move |c| store::set_presence_pref(c, uid, &p)).await?;
    }
    ctx.st.hub.set_presence(uid, &r.presence);
    broadcast_presence(&ctx.st, uid);
    let ev = hub::event("self.presence", &json!({ "presence": r.presence }));
    ctx.st.hub.send_user_except(uid, ctx.conn_id, &ev);
    Ok(json!({}))
}

#[derive(Deserialize)]
struct PasswordReq {
    old_password: String,
    new_password: String,
}

pub async fn change_password(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: PasswordReq = parse(d)?;
    validate_password(&r.new_password)?;
    ctx.take_message_token()?;
    let uid = ctx.uid;
    let hash = ctx.st.db.call(move |c| store::password_hash(c, uid)).await?;
    let old = r.old_password;
    let ok = tokio::task::spawn_blocking(move || auth::verify_password(&old, &hash)).await.unwrap_or(false);
    if !ok {
        return Err(ApiError::new(Code::InvalidCredentials, "Aktuelles Passwort ist falsch"));
    }
    let new = r.new_password;
    let new_hash = tokio::task::spawn_blocking(move || auth::hash_password(&new)).await.map_err(|_| ApiError::internal())??;
    let keep = ctx.token_hash.clone();
    ctx.st
        .db
        .call(move |c| {
            store::set_password_hash(c, uid, &new_hash)?;
            // Sign out every other session.
            c.execute("DELETE FROM sessions WHERE user_id=?1 AND token_hash != ?2", rusqlite::params![uid, keep])?;
            store::audit(c, Some(uid), "user.password", &format!("user:{uid}"), "");
            Ok(())
        })
        .await?;
    Ok(json!({}))
}

#[derive(Deserialize)]
struct UsersReq {
    ids: Vec<i64>,
}

/// Public profiles for arbitrary user ids (e.g. authors of old messages who are no longer members).
pub async fn users_get(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UsersReq = parse(d)?;
    let ids: Vec<i64> = r.ids.into_iter().take(100).collect();
    let users = ctx
        .st
        .db
        .call(move |c| {
            let mut v = Vec::new();
            for id in ids {
                if let Some(u) = store::user_by_id(c, id)? {
                    v.push(u);
                }
            }
            Ok(v)
        })
        .await?;
    let pc = ctx.perms();
    Ok(json!(users.iter().map(|u| member_json(&ctx.st, &pc, u)).collect::<Vec<_>>()))
}

#[derive(Deserialize)]
struct DeleteAccountReq {
    password: String,
    #[serde(default)]
    delete_messages: bool,
}

pub async fn delete_account(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: DeleteAccountReq = parse(d)?;
    let uid = ctx.uid;
    if ctx.perms().is_owner(uid) {
        let owners = ctx.st.db.call(|c| store::count_owners(c)).await?;
        if owners <= 1 {
            return Err(ApiError::new(Code::Conflict, "Der einzige Serverinhaber kann sein Konto nicht löschen"));
        }
    }
    let hash = ctx.st.db.call(move |c| store::password_hash(c, uid)).await?;
    let pw = r.password;
    if !tokio::task::spawn_blocking(move || auth::verify_password(&pw, &hash)).await.unwrap_or(false) {
        return Err(ApiError::new(Code::InvalidCredentials, "Passwort ist falsch"));
    }
    let del = r.delete_messages;
    let (avatar, atts) = ctx
        .st
        .db
        .call(move |c| {
            let res = store::delete_user(c, uid, del)?;
            store::audit(c, Some(uid), "user.delete", &format!("user:{uid}"), if del { "with messages" } else { "" });
            Ok(res)
        })
        .await?;
    if let Some(a) = avatar {
        files::remove_avatar(&ctx.st, &a);
    }
    files::remove_attachments(&ctx.st, &atts);
    ctx.st.reload_perms().await?;
    ops_voice::force_leave(&ctx.st, uid);
    ctx.st.hub.broadcast(&hub::event("member.removed", &json!({ "user_id": uid })), |_| true);
    ctx.st.hub.disconnect_user(uid, 4003, "account deleted");
    Ok(json!({}))
}

#[derive(Deserialize)]
struct UserReq {
    user_id: i64,
}

async fn target_active(ctx: &Ctx, user_id: i64) -> ApiResult<store::User> {
    if user_id == ctx.uid {
        return Err(ApiError::invalid("Das bist du selbst"));
    }
    let u = ctx.st.db.call(move |c| store::user_by_id(c, user_id)).await?;
    u.filter(|u| u.status == "active").ok_or_else(|| ApiError::not_found("Benutzer"))
}

pub async fn dm_open(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    // A DM with yourself is the "notes to self" channel; others must be active.
    if r.user_id != ctx.uid {
        target_active(ctx, r.user_id).await?;
    }
    let (a, b) = (ctx.uid, r.user_id);
    let (cid, created) = ctx
        .st
        .db
        .call(move |c| {
            if store::is_blocked_either(c, a, b)? {
                return Err(ApiError::new(Code::Blocked, "Direktnachrichten mit diesem Benutzer sind nicht möglich"));
            }
            store::find_or_create_dm(c, a, b)
        })
        .await?;
    if created {
        ctx.st.reload_perms().await?;
        ctx.st.hub.send_user(a, &hub::event("dm.created", &json!({ "channel_id": cid, "user_id": b, "last_message_id": null })));
        ctx.st.hub.send_user(b, &hub::event("dm.created", &json!({ "channel_id": cid, "user_id": a, "last_message_id": null })));
    }
    Ok(json!({ "channel_id": cid, "user_id": b }))
}

fn notify_rel(ctx: &Ctx, user: i64, target: i64, kind: Option<&str>) {
    ctx.st.hub.send_user(user, &hub::event("relationship.update", &json!({ "user_id": target, "kind": kind })));
}

pub async fn rel_request(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    ctx.take_message_token()?;
    target_active(ctx, r.user_id).await?;
    let (me, other) = (ctx.uid, r.user_id);
    let (mine, theirs) = ctx
        .st
        .db
        .call(move |c| {
            if store::is_blocked_either(c, me, other)? {
                return Err(ApiError::new(Code::Blocked, "Anfrage nicht möglich"));
            }
            let mine = store::relationship(c, me, other)?;
            if mine.as_deref() == Some("friend") {
                return Ok(("friend", "friend"));
            }
            // Accepting an incoming request makes both friends.
            let pair = if mine.as_deref() == Some("incoming") { ("friend", "friend") } else { ("outgoing", "incoming") };
            store::set_relationship(c, me, other, Some(pair.0))?;
            store::set_relationship(c, other, me, Some(pair.1))?;
            Ok(pair)
        })
        .await?;
    notify_rel(ctx, me, other, Some(mine));
    notify_rel(ctx, other, me, Some(theirs));
    Ok(json!({ "kind": mine }))
}

pub async fn rel_remove(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    let (me, other) = (ctx.uid, r.user_id);
    let theirs_removed = ctx
        .st
        .db
        .call(move |c| {
            if store::relationship(c, me, other)?.as_deref() != Some("blocked") {
                store::set_relationship(c, me, other, None)?;
            }
            let theirs = store::relationship(c, other, me)?;
            if matches!(theirs.as_deref(), Some("friend" | "incoming" | "outgoing")) {
                store::set_relationship(c, other, me, None)?;
                return Ok(true);
            }
            Ok(false)
        })
        .await?;
    notify_rel(ctx, me, other, None);
    if theirs_removed {
        notify_rel(ctx, other, me, None);
    }
    Ok(json!({}))
}

pub async fn rel_block(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    if r.user_id == ctx.uid {
        return Err(ApiError::invalid("Das bist du selbst"));
    }
    let (me, other) = (ctx.uid, r.user_id);
    let theirs_removed = ctx
        .st
        .db
        .call(move |c| {
            store::set_relationship(c, me, other, Some("blocked"))?;
            let theirs = store::relationship(c, other, me)?;
            if matches!(theirs.as_deref(), Some("friend" | "incoming" | "outgoing")) {
                store::set_relationship(c, other, me, None)?;
                return Ok(true);
            }
            Ok(false)
        })
        .await?;
    notify_rel(ctx, me, other, Some("blocked"));
    if theirs_removed {
        notify_rel(ctx, other, me, None);
    }
    Ok(json!({}))
}

pub async fn rel_unblock(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    let (me, other) = (ctx.uid, r.user_id);
    ctx.st
        .db
        .call(move |c| {
            if store::relationship(c, me, other)?.as_deref() == Some("blocked") {
                store::set_relationship(c, me, other, None)?;
            }
            Ok(())
        })
        .await?;
    notify_rel(ctx, me, other, None);
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Direct connections between two users (file transfer without the server)
// ---------------------------------------------------------------------------

/// Upper bound for one relayed signaling payload (an SDP with all candidates).
const MAX_P2P_SIGNAL: usize = 64 * 1024;

#[derive(Deserialize)]
struct P2pReq {
    to: i64,
    data: Value,
}

/// Relays a small signaling message (offer, answer, accept/decline) to another
/// online user so the two clients can open a direct WebRTC data channel. The
/// transferred data itself never touches the server.
pub async fn p2p_signal(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: P2pReq = parse(d)?;
    if r.data.to_string().len() > MAX_P2P_SIGNAL {
        return Err(ApiError::invalid("Signal ist zu groß"));
    }
    target_active(ctx, r.to).await?;
    let (a, b) = (ctx.uid, r.to);
    if ctx.st.db.call(move |c| store::is_blocked_either(c, a, b)).await? {
        return Err(ApiError::new(Code::Blocked, "Direktübertragung mit diesem Benutzer ist nicht möglich"));
    }
    if !ctx.st.hub.is_online(r.to) {
        return Err(ApiError::new(Code::NotFound, "Benutzer ist nicht online"));
    }
    ctx.st.hub.send_user(r.to, &hub::event("p2p.signal", &json!({ "from": ctx.uid, "data": r.data })));
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// End-to-end encryption: public key directory
// ---------------------------------------------------------------------------

/// Keys kept per user (older ones stay so old messages remain readable).
const MAX_E2E_KEYS: i64 = 20;

#[derive(Deserialize)]
struct E2ePublishReq {
    kid: String,
    key: String,
}

fn valid_kid(k: &str) -> bool {
    k.len() == 16 && k.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn valid_pubkey(k: &str) -> bool {
    (80..=200).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'+' || b == b'/' || b == b'=')
}

/// Publishes the caller's public key for encrypted direct messages.
pub async fn e2e_publish(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: E2ePublishReq = parse(d)?;
    if !valid_kid(&r.kid) || !valid_pubkey(&r.key) {
        return Err(ApiError::invalid("Ungültiger Schlüssel"));
    }
    let uid = ctx.uid;
    let (kid, key) = (r.kid.clone(), r.key);
    let added = ctx.st.db.call(move |c| store::e2e_add_key(c, uid, &kid, &key, MAX_E2E_KEYS)).await?;
    if added {
        ctx.st.hub.broadcast(&hub::event("e2e.key", &json!({ "user_id": uid, "kid": r.kid })), |_| true);
    }
    Ok(json!({ "added": added }))
}

#[derive(Deserialize)]
struct E2eKeysReq {
    user_ids: Vec<i64>,
}

/// Public keys of the given users, newest first per user.
pub async fn e2e_keys(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: E2eKeysReq = parse(d)?;
    if r.user_ids.is_empty() || r.user_ids.len() > 50 {
        return Err(ApiError::invalid("user_ids: 1 bis 50 Einträge"));
    }
    let keys = ctx.st.db.call(move |c| store::e2e_keys(c, &r.user_ids)).await?;
    Ok(json!({ "keys": keys }))
}

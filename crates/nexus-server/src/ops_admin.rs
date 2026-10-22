//! Server structure and administration: channels, categories, roles,
//! members, invites, settings, logs, backups.

use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult, Code};
use crate::perms::{self, Perms};
use crate::store::{self, RegistrationMode};
use crate::util::{clean_name, clean_text, now_ms, random_code};
use crate::ws::{parse, server_public, Ctx};
use crate::{files, hub, logbuf, maintenance, ops_voice};

fn double_option<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

/// Text channel names are lower-case with dashes, like `#allgemein`.
fn channel_name(kind: &str, name: &str) -> ApiResult<String> {
    let n = clean_name(name, 64, "Kanalname")?;
    if kind == "text" {
        let n: String = n.to_lowercase().split_whitespace().collect::<Vec<_>>().join("-");
        if n.is_empty() {
            return Err(ApiError::invalid("Kanalname: darf nicht leer sein"));
        }
        return Ok(n);
    }
    Ok(n)
}

async fn after_structure_change(ctx: &Ctx) -> ApiResult<()> {
    ctx.st.reload_perms().await?;
    ctx.st.sync_guild().await
}

// ---------------------------------------------------------------------------
// Channels & categories
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct ChannelCreate {
    kind: String,
    name: String,
    #[serde(default)]
    topic: String,
    category_id: Option<i64>,
}

pub async fn channel_create(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ChannelCreate = parse(d)?;
    ctx.require(perms::CREATE_CHANNELS)?;
    if r.kind != "text" && r.kind != "voice" {
        return Err(ApiError::invalid("Kanaltyp muss 'text' oder 'voice' sein"));
    }
    let name = channel_name(&r.kind, &r.name)?;
    let topic = clean_text(&r.topic, 256, false, "Thema")?;
    let (kind, cat) = (r.kind, r.category_id);
    let ch = ctx
        .st
        .db
        .call(move |c| {
            if let Some(cat) = cat {
                if !store::list_categories(c)?.iter().any(|x| x.id == cat) {
                    return Err(ApiError::not_found("Kategorie"));
                }
            }
            let id = store::create_channel(c, &kind, &name, &topic, cat)?;
            store::channel_by_id(c, id)
        })
        .await?
        .ok_or_else(ApiError::internal)?;
    ctx.audit("channel.create", format!("channel:{}", ch.id), ch.name.clone());
    after_structure_change(ctx).await?;
    Ok(json!(ch))
}

#[derive(Deserialize)]
struct ChannelUpdate {
    channel_id: i64,
    name: Option<String>,
    topic: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    category_id: Option<Option<i64>>,
    position: Option<i64>,
}

pub async fn channel_update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ChannelUpdate = parse(d)?;
    ctx.require_in(r.channel_id, perms::MANAGE_CHANNELS)?;
    let id = r.channel_id;
    let mut ch = ctx.st.db.call(move |c| store::channel_by_id(c, id)).await?.ok_or_else(|| ApiError::not_found("Kanal"))?;
    if ch.kind == "dm" {
        return Err(ApiError::denied());
    }
    if let Some(n) = r.name {
        ch.name = channel_name(&ch.kind, &n)?;
    }
    if let Some(t) = r.topic {
        ch.topic = clean_text(&t, 256, false, "Thema")?;
    }
    if let Some(cat) = r.category_id {
        ch.category_id = cat;
    }
    if let Some(p) = r.position {
        ch.position = p.clamp(0, 10_000);
    }
    let ch2 = ch.clone();
    ctx.st
        .db
        .call(move |c| {
            if let Some(cat) = ch2.category_id {
                if !store::list_categories(c)?.iter().any(|x| x.id == cat) {
                    return Err(ApiError::not_found("Kategorie"));
                }
            }
            store::update_channel(c, &ch2)
        })
        .await?;
    ctx.audit("channel.update", format!("channel:{}", ch.id), ch.name.clone());
    after_structure_change(ctx).await?;
    Ok(json!(ch))
}

#[derive(Deserialize)]
struct ChannelId {
    channel_id: i64,
}

pub async fn channel_delete(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ChannelId = parse(d)?;
    ctx.require_in(r.channel_id, perms::MANAGE_CHANNELS)?;
    let id = r.channel_id;
    let ch = ctx.st.db.call(move |c| store::channel_by_id(c, id)).await?.ok_or_else(|| ApiError::not_found("Kanal"))?;
    if ch.kind == "dm" {
        return Err(ApiError::denied());
    }
    let in_voice: Vec<i64> = ctx.st.voice.lock().unwrap_or_else(|p| p.into_inner()).channel_members(id).iter().map(|m| m.user_id).collect();
    for u in in_voice {
        ops_voice::force_leave(&ctx.st, u);
    }
    let removed = ctx.st.db.call(move |c| store::delete_channel(c, id)).await?;
    files::remove_attachments(&ctx.st, &removed);
    ctx.audit("channel.delete", format!("channel:{id}"), ch.name);
    after_structure_change(ctx).await?;
    Ok(json!({}))
}

pub async fn channel_overrides(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ChannelId = parse(d)?;
    ctx.require(perms::MANAGE_ROLES)?;
    let id = r.channel_id;
    let o = ctx.st.db.call(move |c| store::list_overrides(c, id)).await?;
    Ok(json!(o))
}

#[derive(Deserialize)]
struct SetOverride {
    channel_id: i64,
    role_id: i64,
    allow: Perms,
    deny: Perms,
}

pub async fn channel_set_override(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SetOverride = parse(d)?;
    ctx.require(perms::MANAGE_ROLES)?;
    {
        let pc = ctx.perms();
        let ch = pc.channels.get(&r.channel_id).ok_or_else(|| ApiError::not_found("Kanal"))?;
        if ch.is_dm {
            return Err(ApiError::denied());
        }
        let role = pc.roles.get(&r.role_id).ok_or_else(|| ApiError::not_found("Rolle"))?;
        if !pc.is_owner(ctx.uid) && role.position >= pc.rank(ctx.uid) {
            return Err(ApiError::new(Code::PermissionDenied, "Rolle steht über deiner eigenen"));
        }
        if (r.allow & !pc.base(ctx.uid)) != 0 {
            return Err(ApiError::new(Code::PermissionDenied, "Du kannst keine Rechte vergeben, die du selbst nicht hast"));
        }
    }
    let (allow, deny) = (r.allow & perms::CHANNEL_SCOPED, r.deny & perms::CHANNEL_SCOPED & !r.allow);
    ctx.st.db.call(move |c| store::set_override(c, r.channel_id, r.role_id, allow, deny)).await?;
    ctx.audit("channel.override", format!("channel:{}", r.channel_id), format!("role:{} allow:{allow} deny:{deny}", r.role_id));
    after_structure_change(ctx).await?;
    Ok(json!({ "role_id": r.role_id, "allow": allow, "deny": deny }))
}

#[derive(Deserialize)]
struct CategoryCreate {
    name: String,
}

pub async fn category_create(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: CategoryCreate = parse(d)?;
    ctx.require(perms::CREATE_CHANNELS)?;
    let name = clean_name(&r.name, 64, "Kategoriename")?;
    let n2 = name.clone();
    let id = ctx.st.db.call(move |c| store::create_category(c, &n2)).await?;
    ctx.audit("category.create", format!("category:{id}"), name.clone());
    after_structure_change(ctx).await?;
    Ok(json!({ "id": id, "name": name }))
}

#[derive(Deserialize)]
struct CategoryUpdate {
    category_id: i64,
    name: String,
    #[serde(default)]
    position: i64,
}

pub async fn category_update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: CategoryUpdate = parse(d)?;
    ctx.require(perms::MANAGE_CHANNELS)?;
    let name = clean_name(&r.name, 64, "Kategoriename")?;
    let pos = r.position.clamp(0, 10_000);
    if !ctx.st.db.call(move |c| store::update_category(c, r.category_id, &name, pos)).await? {
        return Err(ApiError::not_found("Kategorie"));
    }
    after_structure_change(ctx).await?;
    Ok(json!({}))
}

#[derive(Deserialize)]
struct CategoryId {
    category_id: i64,
}

pub async fn category_delete(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: CategoryId = parse(d)?;
    ctx.require(perms::MANAGE_CHANNELS)?;
    // Channels of the category are kept and become uncategorized.
    if !ctx.st.db.call(move |c| store::delete_category(c, r.category_id)).await? {
        return Err(ApiError::not_found("Kategorie"));
    }
    ctx.audit("category.delete", format!("category:{}", r.category_id), String::new());
    after_structure_change(ctx).await?;
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Roles & members
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RoleCreate {
    name: String,
    #[serde(default)]
    permissions: Perms,
    #[serde(default)]
    color: String,
    position: Option<i64>,
    #[serde(default)]
    is_default: bool,
}

fn clean_color(c: &str) -> ApiResult<String> {
    let c = c.trim();
    if c.is_empty() || (c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())) {
        Ok(c.to_string())
    } else {
        Err(ApiError::invalid("Farbe muss im Format #RRGGBB angegeben werden"))
    }
}

pub async fn role_create(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: RoleCreate = parse(d)?;
    let name = clean_name(&r.name, 32, "Rollenname")?;
    let color = clean_color(&r.color)?;
    let p = r.permissions & perms::ALL;
    let position = r.position.unwrap_or(15).clamp(1, 1_000_000);
    if !ctx.perms().can_manage_role(ctx.uid, position, p) {
        return Err(ApiError::denied());
    }
    let n2 = name.clone();
    let id = ctx.st.db.call(move |c| store::create_role(c, &n2, p, position, &color, r.is_default)).await?;
    ctx.audit("role.create", format!("role:{id}"), format!("{name} perms:{p}"));
    after_structure_change(ctx).await?;
    Ok(json!({ "id": id }))
}

#[derive(Deserialize)]
struct RoleUpdate {
    role_id: i64,
    name: Option<String>,
    permissions: Option<Perms>,
    color: Option<String>,
    position: Option<i64>,
    is_default: Option<bool>,
}

pub async fn role_update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: RoleUpdate = parse(d)?;
    let id = r.role_id;
    let mut role = ctx.st.db.call(move |c| store::role_by_id(c, id)).await?.ok_or_else(|| ApiError::not_found("Rolle"))?;
    if !ctx.perms().can_manage_role(ctx.uid, role.position, 0) {
        return Err(ApiError::denied());
    }
    if let Some(n) = r.name {
        role.name = clean_name(&n, 32, "Rollenname")?;
    }
    if let Some(c) = r.color {
        role.color = clean_color(&c)?;
    }
    if let Some(p) = r.permissions {
        role.permissions = p & perms::ALL;
    }
    if let Some(p) = r.position {
        role.position = p.clamp(1, 1_000_000);
    }
    if let Some(dflt) = r.is_default {
        role.is_default = dflt;
    }
    if !ctx.perms().can_manage_role(ctx.uid, role.position, role.permissions) {
        return Err(ApiError::denied());
    }
    let r2 = role.clone();
    ctx.st.db.call(move |c| store::update_role(c, &r2)).await?;
    ctx.audit("role.update", format!("role:{id}"), format!("{} perms:{}", role.name, role.permissions));
    after_structure_change(ctx).await?;
    Ok(json!(role))
}

#[derive(Deserialize)]
struct RoleId {
    role_id: i64,
}

pub async fn role_delete(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: RoleId = parse(d)?;
    let id = r.role_id;
    let role = ctx.st.db.call(move |c| store::role_by_id(c, id)).await?.ok_or_else(|| ApiError::not_found("Rolle"))?;
    if !ctx.perms().can_manage_role(ctx.uid, role.position, role.permissions) {
        return Err(ApiError::denied());
    }
    ctx.st.db.call(move |c| store::delete_role(c, id)).await?;
    ctx.audit("role.delete", format!("role:{id}"), role.name);
    after_structure_change(ctx).await?;
    Ok(json!({}))
}

#[derive(Deserialize)]
struct SetRoles {
    user_id: i64,
    role_ids: Vec<i64>,
}

pub async fn member_set_roles(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SetRoles = parse(d)?;
    ctx.require(perms::MANAGE_ROLES)?;
    let mut new_roles = r.role_ids.clone();
    new_roles.sort_unstable();
    new_roles.dedup();
    {
        let pc = ctx.perms();
        let owner = pc.is_owner(ctx.uid);
        if !owner && !pc.outranks(ctx.uid, r.user_id) {
            return Err(ApiError::new(Code::PermissionDenied, "Du kannst nur Benutzer unterhalb deiner Rolle verwalten"));
        }
        let rank = pc.rank(ctx.uid);
        let old: Vec<i64> = pc.roles_of(r.user_id).to_vec();
        for role in new_roles.iter().filter(|x| !old.contains(x)).chain(old.iter().filter(|x| !new_roles.contains(x))) {
            let info = pc.roles.get(role).ok_or_else(|| ApiError::not_found("Rolle"))?;
            if !owner && info.position >= rank {
                return Err(ApiError::new(Code::PermissionDenied, "Rolle steht über deiner eigenen"));
            }
        }
    }
    let uid = r.user_id;
    let roles = new_roles.clone();
    let user = ctx
        .st
        .db
        .call(move |c| {
            let u = store::user_by_id(c, uid)?.filter(|u| u.status == "active").ok_or_else(|| ApiError::not_found("Benutzer"))?;
            store::set_user_roles(c, uid, &roles)?;
            Ok(u)
        })
        .await?;
    ctx.audit("member.roles", format!("user:{uid}"), format!("{new_roles:?}"));
    after_structure_change(ctx).await?;
    crate::ops_social::broadcast_member(&ctx.st, &user);
    Ok(json!({}))
}

#[derive(Deserialize)]
struct StatusReq {
    status: String,
}

pub async fn member_list_status(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: StatusReq = parse(d)?;
    ctx.require(perms::BAN_MEMBERS)?;
    if r.status != "pending" && r.status != "banned" {
        return Err(ApiError::invalid("Status muss 'pending' oder 'banned' sein"));
    }
    let users = ctx.st.db.call(move |c| store::users_with_status(c, &r.status)).await?;
    Ok(json!(users))
}

#[derive(Deserialize)]
struct UserReq {
    user_id: i64,
    #[serde(default)]
    reason: String,
}

async fn load_user_with_status(ctx: &Ctx, uid: i64, status: &'static str) -> ApiResult<store::User> {
    ctx.st
        .db
        .call(move |c| store::user_by_id(c, uid))
        .await?
        .filter(|u| u.status == status)
        .ok_or_else(|| ApiError::not_found("Benutzer"))
}

pub async fn member_approve(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    ctx.require(perms::BAN_MEMBERS)?;
    load_user_with_status(ctx, r.user_id, "pending").await?;
    let uid = r.user_id;
    let user = ctx
        .st
        .db
        .call(move |c| {
            store::set_user_status(c, uid, "active")?;
            let roles = store::default_role_ids(c)?;
            store::add_user_roles(c, uid, &roles)?;
            store::user_by_id(c, uid)
        })
        .await?
        .ok_or_else(ApiError::internal)?;
    ctx.audit("member.approve", format!("user:{uid}"), user.username.clone());
    ctx.st.reload_perms().await?;
    crate::ops_social::broadcast_member(&ctx.st, &user);
    Ok(json!({}))
}

pub async fn member_reject(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    ctx.require(perms::BAN_MEMBERS)?;
    let u = load_user_with_status(ctx, r.user_id, "pending").await?;
    let uid = r.user_id;
    ctx.st.db.call(move |c| store::delete_user(c, uid, true)).await?;
    ctx.audit("member.reject", format!("user:{uid}"), u.username);
    Ok(json!({}))
}

pub async fn member_ban(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    ctx.require(perms::BAN_MEMBERS)?;
    if !ctx.perms().outranks(ctx.uid, r.user_id) {
        return Err(ApiError::new(Code::PermissionDenied, "Du kannst nur Benutzer unterhalb deiner Rolle sperren"));
    }
    let u = load_user_with_status(ctx, r.user_id, "active").await?;
    if u.is_owner {
        return Err(ApiError::denied());
    }
    let uid = r.user_id;
    ctx.st
        .db
        .call(move |c| {
            store::set_user_status(c, uid, "banned")?;
            store::delete_user_sessions(c, uid)
        })
        .await?;
    let reason = clean_text(&r.reason, 256, false, "Grund").unwrap_or_default();
    ctx.audit("member.ban", format!("user:{uid}"), format!("{} {}", u.username, reason));
    ctx.st.reload_perms().await?;
    ops_voice::force_leave(&ctx.st, uid);
    ctx.st.hub.disconnect_user(uid, 4003, "banned");
    ctx.st.hub.broadcast(&hub::event("member.removed", &json!({ "user_id": uid })), |_| true);
    Ok(json!({}))
}

pub async fn member_unban(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UserReq = parse(d)?;
    ctx.require(perms::BAN_MEMBERS)?;
    load_user_with_status(ctx, r.user_id, "banned").await?;
    let uid = r.user_id;
    let user = ctx
        .st
        .db
        .call(move |c| {
            store::set_user_status(c, uid, "active")?;
            store::user_by_id(c, uid)
        })
        .await?
        .ok_or_else(ApiError::internal)?;
    ctx.audit("member.unban", format!("user:{uid}"), user.username.clone());
    ctx.st.reload_perms().await?;
    crate::ops_social::broadcast_member(&ctx.st, &user);
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct InviteCreate {
    max_uses: Option<i64>,
    /// Hours until expiry; 0 = never (requires MANAGE_SERVER). Default 7 days.
    expires_hours: Option<i64>,
    role_id: Option<i64>,
}

pub fn invite_link_info(ctx: &Ctx) -> Value {
    let cfg = &ctx.st.cfg;
    json!({ "host": cfg.public_host, "port": cfg.port, "tls": cfg.tls.enabled, "fingerprint": ctx.st.fingerprint })
}

pub async fn invite_create(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: InviteCreate = parse(d)?;
    ctx.require(perms::CREATE_INVITES)?;
    let max_uses = r.max_uses.filter(|m| *m > 0);
    if max_uses.is_some_and(|m| m > 10_000) {
        return Err(ApiError::invalid("Maximal 10000 Nutzungen"));
    }
    let hours = r.expires_hours.unwrap_or(24 * 7);
    if hours == 0 {
        ctx.require(perms::MANAGE_SERVER)?;
    } else if !(1..=24 * 365).contains(&hours) {
        return Err(ApiError::invalid("Gültigkeit: 1 Stunde bis 1 Jahr"));
    }
    if let Some(role) = r.role_id {
        let pc = ctx.perms();
        let info = pc.roles.get(&role).ok_or_else(|| ApiError::not_found("Rolle"))?;
        if !pc.has(ctx.uid, perms::MANAGE_ROLES) || (!pc.is_owner(ctx.uid) && info.position >= pc.rank(ctx.uid)) {
            return Err(ApiError::denied());
        }
    }
    let code = random_code(8);
    let expires = (hours > 0).then(|| now_ms() + hours * 3_600_000);
    let (c2, uid) = (code.clone(), ctx.uid);
    ctx.st.db.call(move |c| store::create_invite(c, &c2, Some(uid), expires, max_uses, r.role_id, false)).await?;
    ctx.audit("invite.create", format!("invite:{code}"), String::new());
    Ok(json!({
        "code": code, "expires_at": expires, "max_uses": max_uses, "role_id": r.role_id,
        "link": invite_link_info(ctx),
    }))
}

pub async fn invite_list(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    ctx.require(perms::CREATE_INVITES)?;
    let list = ctx.st.db.call(|c| store::list_invites(c)).await?;
    Ok(json!({ "invites": list, "link": invite_link_info(ctx) }))
}

#[derive(Deserialize)]
struct InviteDelete {
    code: String,
}

pub async fn invite_delete(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: InviteDelete = parse(d)?;
    ctx.require(perms::CREATE_INVITES)?;
    let code = r.code.trim().to_ascii_uppercase();
    let c2 = code.clone();
    let inv = ctx.st.db.call(move |c| store::list_invites(c)).await?.into_iter().find(|i| i.code == c2);
    let inv = inv.ok_or_else(|| ApiError::not_found("Einladung"))?;
    if inv.created_by != Some(ctx.uid) {
        ctx.require(perms::MANAGE_SERVER)?;
    }
    ctx.st.db.call(move |c| store::delete_invite(c, &code)).await?;
    ctx.audit("invite.delete", format!("invite:{}", inv.code), String::new());
    Ok(json!({}))
}

// ---------------------------------------------------------------------------
// Settings, monitoring, backups
// ---------------------------------------------------------------------------

pub async fn server_settings(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    ctx.require(perms::MANAGE_SERVER)?;
    let cfg = &ctx.st.cfg;
    Ok(json!({
        "settings": ctx.st.settings(),
        "config": {
            "bind": cfg.bind, "port": cfg.port, "public_host": cfg.public_host, "exposed": cfg.is_exposed(),
            "tls": cfg.tls.enabled, "fingerprint": ctx.st.fingerprint,
            "stun": cfg.media.stun_enabled, "turn": cfg.media.turn_enabled, "udp_port": cfg.media.udp_port,
        }
    }))
}

#[derive(Deserialize)]
struct ServerUpdate {
    name: Option<String>,
    description: Option<String>,
    registration_mode: Option<RegistrationMode>,
    uploads_enabled: Option<bool>,
    max_upload_mb: Option<u32>,
    max_storage_mb: Option<u32>,
    retention_days: Option<u32>,
}

pub async fn server_update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ServerUpdate = parse(d)?;
    ctx.require(perms::MANAGE_SERVER)?;
    let mut s = ctx.st.settings();
    if let Some(n) = r.name {
        s.name = clean_name(&n, 64, "Servername")?;
    }
    if let Some(dsc) = r.description {
        s.description = clean_text(&dsc, 500, true, "Beschreibung")?;
    }
    if let Some(m) = r.registration_mode {
        s.registration_mode = m;
    }
    if let Some(u) = r.uploads_enabled {
        s.uploads_enabled = u;
    }
    if let Some(m) = r.max_upload_mb {
        if !(1..=2048).contains(&m) {
            return Err(ApiError::invalid("Upload-Limit: 1 bis 2048 MB"));
        }
        s.max_upload_mb = m;
    }
    if let Some(m) = r.max_storage_mb {
        if !(1..=1_000_000).contains(&m) {
            return Err(ApiError::invalid("Speicherlimit ungültig"));
        }
        s.max_storage_mb = m;
    }
    if let Some(days) = r.retention_days {
        if days > 36_500 {
            return Err(ApiError::invalid("Aufbewahrung: höchstens 36500 Tage"));
        }
        s.retention_days = days;
    }
    let s2 = s.clone();
    ctx.st.db.call(move |c| store::put_settings(c, &s2)).await?;
    *ctx.st.settings.write().unwrap_or_else(|p| p.into_inner()) = s.clone();
    ctx.audit("server.update", "server".into(), format!("registration:{:?} uploads:{}", s.registration_mode, s.uploads_enabled));
    ctx.st.hub.broadcast(&hub::event("server.updated", &server_public(&ctx.st)), |_| true);
    Ok(json!(s))
}

pub async fn server_stats(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    let pc_ok = {
        let pc = ctx.perms();
        pc.has(ctx.uid, perms::MANAGE_SERVER) || pc.has(ctx.uid, perms::VIEW_AUDIT_LOG)
    };
    if !pc_ok {
        return Err(ApiError::denied());
    }
    Ok(json!(ctx.st.stats().await?))
}

#[derive(Deserialize)]
struct LogsReq {
    limit: Option<usize>,
    level: Option<String>,
}

pub async fn server_logs(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: LogsReq = parse(d)?;
    ctx.require(perms::MANAGE_SERVER)?;
    let level = r.level.and_then(|l| l.parse::<tracing::Level>().ok());
    Ok(json!(logbuf::LogBuffer::global().recent(r.limit.unwrap_or(300).min(1000), level)))
}

pub async fn server_restart(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    ctx.require_owner()?;
    ctx.audit("server.restart", "server".into(), String::new());
    ctx.st.request_restart();
    Ok(json!({}))
}

#[derive(Deserialize)]
struct AuditReq {
    before: Option<i64>,
}

pub async fn audit_list(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: AuditReq = parse(d)?;
    ctx.require(perms::VIEW_AUDIT_LOG)?;
    let entries = ctx.st.db.call(move |c| store::list_audit(c, r.before, 100)).await?;
    Ok(json!(entries))
}

pub async fn backup_create(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    ctx.require_owner()?;
    let info = maintenance::create_backup(&ctx.st).await?;
    ctx.audit("backup.create", info.name.clone(), String::new());
    Ok(json!(info))
}

pub async fn backup_list(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    ctx.require_owner()?;
    Ok(json!(maintenance::list_backups(&ctx.st)?))
}

#[derive(Deserialize)]
struct RestoreReq {
    name: String,
}

pub async fn backup_restore(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: RestoreReq = parse(d)?;
    ctx.require_owner()?;
    maintenance::stage_restore(&ctx.st, &r.name)?;
    ctx.audit("backup.restore", r.name, String::new());
    // The audit entry above is written to the old database before the swap.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    ctx.st.request_restart();
    Ok(json!({ "restarting": true }))
}

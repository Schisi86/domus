//! WebSocket connection handling.
//!
//! Wire format (JSON text frames):
//! * request  `{"id": 7, "op": "message.send", "d": {...}}`
//! * response `{"re": 7, "ok": true, "d": {...}}` or `{"re": 7, "ok": false, "err": {"code": "...", "msg": "..."}}`
//! * event    `{"ev": "message.created", "d": {...}}`
//!
//! The first request must be `auth` with a session token; its response carries
//! the full initial state ("ready").

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, State};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Notify};

use crate::error::{ApiError, ApiResult, Code};
use crate::hub::{self, Out};
use crate::perms::{self, PermCache};
use crate::ratelimit::Bucket;
use crate::store::{self, Category, Channel, Role, User};
use crate::{auth, ops_admin, ops_chat, ops_social, ops_voice, AppState};

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
/// Clients send a `ping` op every 30 s; silence for this long means the peer is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(75);
pub const MAX_FRAME: usize = 128 * 1024;

#[derive(Deserialize)]
struct Req {
    id: Option<u64>,
    op: String,
    #[serde(default)]
    d: Value,
}

/// Per-connection context passed to every op handler.
pub struct Ctx {
    pub st: Arc<AppState>,
    pub uid: i64,
    pub username: String,
    pub conn_id: u64,
    pub token_hash: Vec<u8>,
    pub ip: IpAddr,
    ops: Bucket,
    msgs: Bucket,
    strikes: u32,
}

impl Ctx {
    pub fn perms(&self) -> std::sync::RwLockReadGuard<'_, PermCache> {
        self.st.perms()
    }

    pub fn require(&self, perm: perms::Perms) -> ApiResult<()> {
        if self.perms().has(self.uid, perm) { Ok(()) } else { Err(ApiError::denied()) }
    }

    pub fn require_in(&self, channel_id: i64, perm: perms::Perms) -> ApiResult<()> {
        let pc = self.perms();
        if !pc.channels.contains_key(&channel_id) || !pc.has_in(self.uid, channel_id, perms::VIEW_CHANNEL) {
            return Err(ApiError::not_found("Kanal"));
        }
        if pc.has_in(self.uid, channel_id, perm) { Ok(()) } else { Err(ApiError::denied()) }
    }

    pub fn require_owner(&self) -> ApiResult<()> {
        if self.perms().is_owner(self.uid) { Ok(()) } else { Err(ApiError::denied()) }
    }

    pub fn take_message_token(&mut self) -> ApiResult<()> {
        if self.msgs.try_take() { Ok(()) } else { Err(ApiError::rate_limited()) }
    }

    pub fn audit(&self, action: &'static str, target: String, detail: String) {
        let uid = self.uid;
        let db = self.st.db.clone();
        tracing::info!(actor = %self.username, action, %target, "audit");
        tokio::spawn(async move {
            let _ = db.call(move |c| {
                store::audit(c, Some(uid), action, &target, &detail);
                Ok(())
            })
            .await;
        });
    }
}

pub fn parse<T: DeserializeOwned>(d: Value) -> ApiResult<T> {
    serde_json::from_value(d).map_err(|e| ApiError::bad(format!("Ungültige Anfrage: {e}")))
}

pub async fn ws_handler(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> Response {
    let ip = addr.ip();
    if st.hub.total() >= st.cfg.limits.max_connections {
        return ApiError::new(Code::ServerFull, "Server ist ausgelastet").into_response();
    }
    // Through the app's internet relay every client arrives from loopback, so
    // only the global limit applies there.
    if !ip.is_loopback() && st.hub.ip_count(ip) >= st.cfg.limits.max_connections_per_ip {
        return ApiError::rate_limited().into_response();
    }
    ws.max_message_size(MAX_FRAME).max_frame_size(MAX_FRAME).on_upgrade(move |socket| run(st, socket, ip))
}

fn response(id: Option<u64>, r: ApiResult<Value>) -> Arc<str> {
    let v = match r {
        Ok(d) => json!({ "re": id, "ok": true, "d": d }),
        Err(e) => json!({ "re": id, "ok": false, "err": e }),
    };
    v.to_string().into()
}

async fn authenticate(st: &Arc<AppState>, socket: &mut WebSocket) -> Option<(User, Vec<u8>, Option<u64>)> {
    let first = tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await.ok()??.ok()?;
    let Message::Text(text) = first else { return None };
    let req: Req = serde_json::from_str(text.as_str()).ok()?;
    #[derive(Deserialize)]
    struct AuthReq {
        token: String,
    }
    let fail = |code, msg: &str| response(req.id, Err(ApiError::new(code, msg)));
    if req.op != "auth" {
        let _ = socket.send(Message::Text(fail(Code::Unauthorized, "Anmeldung erforderlich").as_ref().into())).await;
        return None;
    }
    let Ok(a) = serde_json::from_value::<AuthReq>(req.d) else {
        let _ = socket.send(Message::Text(fail(Code::BadRequest, "Token fehlt").as_ref().into())).await;
        return None;
    };
    let th = auth::token_hash(&a.token);
    let max_age = st.cfg.limits.session_days as i64 * 86_400_000;
    let th2 = th.clone();
    match st.db.call(move |c| store::session_user(c, &th2, max_age)).await {
        Ok(Some(u)) => Some((u, th, req.id)),
        _ => {
            let _ = socket
                .send(Message::Text(fail(Code::Unauthorized, "Sitzung ungültig oder abgelaufen").as_ref().into()))
                .await;
            None
        }
    }
}

async fn run(st: Arc<AppState>, mut socket: WebSocket, ip: IpAddr) {
    let Some((user, token_hash, auth_id)) = authenticate(&st, &mut socket).await else {
        let _ = socket.send(Message::Close(Some(CloseFrame { code: 4001, reason: "unauthorized".into() }))).await;
        return;
    };
    let (tx, mut rx) = mpsc::channel::<Out>(hub::OUTBOX);
    let kill = Arc::new(Notify::new());
    let (conn_id, first) = st.hub.register(user.id, ip, tx.clone(), kill.clone(), &user.presence_pref);
    tracing::debug!(user = %user.username, %ip, conn_id, "connected");

    let ready = build_ready(&st, &user).await;
    let ready_ok = ready.is_ok();
    let _ = tx.try_send(Out::Text(response(auth_id, ready)));
    if first && ready_ok {
        broadcast_presence(&st, user.id);
    }

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            let res = match m {
                Out::Text(s) => sink.send(Message::Text(s.as_ref().into())).await,
                Out::Close(code, reason) => {
                    let _ = sink.send(Message::Close(Some(CloseFrame { code, reason: reason.into() }))).await;
                    break;
                }
            };
            if res.is_err() {
                break;
            }
        }
    });

    let mut ctx = Ctx {
        ops: Bucket::new(st.cfg.limits.ops_per_sec, st.cfg.limits.ops_burst),
        msgs: Bucket::new(st.cfg.limits.messages_per_sec, st.cfg.limits.messages_burst),
        st: st.clone(),
        uid: user.id,
        username: user.username.clone(),
        conn_id,
        token_hash,
        ip,
        strikes: 0,
    };

    if ready_ok {
        loop {
            tokio::select! {
                _ = kill.notified() => break,
                msg = tokio::time::timeout(IDLE_TIMEOUT, stream.next()) => match msg {
                    Ok(Some(Ok(Message::Text(t)))) => {
                        if !handle_frame(&mut ctx, t.as_str(), &tx).await {
                            break;
                        }
                    }
                    Ok(Some(Ok(Message::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => break,
                    Ok(Some(Ok(_))) => {}
                }
            }
        }
    }

    drop(tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    if let Some((uid, last)) = st.hub.unregister(conn_id) {
        ops_voice::on_disconnect(&st, uid, conn_id);
        if last {
            broadcast_presence(&st, uid);
        }
    }
    tracing::debug!(user = %user.username, conn_id, "disconnected");
}

/// Returns false if the connection should be closed.
async fn handle_frame(ctx: &mut Ctx, text: &str, tx: &mpsc::Sender<Out>) -> bool {
    let req: Req = match serde_json::from_str(text) {
        Ok(r) => r,
        Err(_) => {
            ctx.strikes += 1;
            let _ = tx.try_send(Out::Text(response(None, Err(ApiError::bad("Ungültiges JSON")))));
            return ctx.strikes < 20;
        }
    };
    if !ctx.ops.try_take() {
        ctx.strikes += 1;
        let _ = tx.try_send(Out::Text(response(req.id, Err(ApiError::rate_limited()))));
        if ctx.strikes >= 50 {
            tracing::warn!(user = %ctx.username, ip = %ctx.ip, "disconnecting client for flooding");
            let _ = tx.try_send(Out::Close(4008, "rate limited"));
            return false;
        }
        return true;
    }
    let res = dispatch(ctx, &req.op, req.d).await;
    if let Err(e) = &res {
        if e.code == Code::PermissionDenied {
            tracing::debug!(user = %ctx.username, op = %req.op, "permission denied");
        }
    }
    if req.id.is_some() {
        let _ = tx.try_send(Out::Text(response(req.id, res)));
    }
    true
}

async fn dispatch(ctx: &mut Ctx, op: &str, d: Value) -> ApiResult<Value> {
    match op {
        "ping" => Ok(json!({ "t": crate::util::now_ms() })),
        // chat
        "message.send" => ops_chat::send(ctx, d).await,
        "message.edit" => ops_chat::edit(ctx, d).await,
        "message.delete" => ops_chat::delete(ctx, d).await,
        "message.history" => ops_chat::history(ctx, d).await,
        "message.search" => ops_chat::search(ctx, d).await,
        "channel.ack" => ops_chat::ack(ctx, d).await,
        "typing" => ops_chat::typing(ctx, d).await,
        "reaction.add" => ops_chat::reaction_add(ctx, d).await,
        "reaction.remove" => ops_chat::reaction_remove(ctx, d).await,
        "message.pin" => ops_chat::pin(ctx, d).await,
        "message.pins" => ops_chat::pins(ctx, d).await,
        "message.forward" => ops_chat::forward(ctx, d).await,
        "poll.create" => ops_chat::poll_create(ctx, d).await,
        "poll.vote" => ops_chat::poll_vote(ctx, d).await,
        "poll.end" => ops_chat::poll_end(ctx, d).await,
        // structure & administration
        "channel.create" => ops_admin::channel_create(ctx, d).await,
        "channel.update" => ops_admin::channel_update(ctx, d).await,
        "channel.delete" => ops_admin::channel_delete(ctx, d).await,
        "channel.overrides" => ops_admin::channel_overrides(ctx, d).await,
        "channel.set_override" => ops_admin::channel_set_override(ctx, d).await,
        "category.create" => ops_admin::category_create(ctx, d).await,
        "category.update" => ops_admin::category_update(ctx, d).await,
        "category.delete" => ops_admin::category_delete(ctx, d).await,
        "role.create" => ops_admin::role_create(ctx, d).await,
        "role.update" => ops_admin::role_update(ctx, d).await,
        "role.delete" => ops_admin::role_delete(ctx, d).await,
        "member.set_roles" => ops_admin::member_set_roles(ctx, d).await,
        "member.list_status" => ops_admin::member_list_status(ctx, d).await,
        "member.approve" => ops_admin::member_approve(ctx, d).await,
        "member.reject" => ops_admin::member_reject(ctx, d).await,
        "member.ban" => ops_admin::member_ban(ctx, d).await,
        "member.kick" => ops_admin::member_kick(ctx, d).await,
        "member.timeout" => ops_admin::member_timeout(ctx, d).await,
        "member.unban" => ops_admin::member_unban(ctx, d).await,
        "invite.create" => ops_admin::invite_create(ctx, d).await,
        "invite.list" => ops_admin::invite_list(ctx, d).await,
        "invite.delete" => ops_admin::invite_delete(ctx, d).await,
        "server.settings" => ops_admin::server_settings(ctx, d).await,
        "server.update" => ops_admin::server_update(ctx, d).await,
        "server.stats" => ops_admin::server_stats(ctx, d).await,
        "server.logs" => ops_admin::server_logs(ctx, d).await,
        "server.restart" => ops_admin::server_restart(ctx, d).await,
        "audit.list" => ops_admin::audit_list(ctx, d).await,
        "backup.create" => ops_admin::backup_create(ctx, d).await,
        "backup.list" => ops_admin::backup_list(ctx, d).await,
        "backup.restore" => ops_admin::backup_restore(ctx, d).await,
        // users & social
        "user.update" => ops_social::profile_update(ctx, d).await,
        "user.presence" => ops_social::presence(ctx, d).await,
        "user.password" => ops_social::change_password(ctx, d).await,
        "user.get" => ops_social::users_get(ctx, d).await,
        "user.delete_account" => ops_social::delete_account(ctx, d).await,
        "dm.open" => ops_social::dm_open(ctx, d).await,
        "relationship.request" => ops_social::rel_request(ctx, d).await,
        "relationship.remove" => ops_social::rel_remove(ctx, d).await,
        "relationship.block" => ops_social::rel_block(ctx, d).await,
        "relationship.unblock" => ops_social::rel_unblock(ctx, d).await,
        // voice & signaling
        "voice.join" => ops_voice::join(ctx, d).await,
        "voice.leave" => ops_voice::leave(ctx, d).await,
        "voice.update" => ops_voice::update(ctx, d).await,
        "voice.moderate" => ops_voice::moderate(ctx, d).await,
        "voice.move" => ops_voice::move_member(ctx, d).await,
        "voice.sound" => ops_voice::sound(ctx, d).await,
        "rtc.signal" => ops_voice::signal(ctx, d).await,
        _ => Err(ApiError::bad(format!("Unbekannte Operation: {op}"))),
    }
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

pub fn member_json(st: &AppState, pc: &PermCache, u: &User) -> Value {
    json!({
        "id": u.id,
        "username": u.username,
        "display_name": u.display_name,
        "avatar": u.avatar,
        "status_text": u.status_text,
        "is_owner": u.is_owner,
        "roles": pc.roles_of(u.id),
        "presence": st.hub.public_presence(u.id),
        "status": u.status,
        "timeout_until": pc.timeout_until(u.id),
    })
}

pub fn guild_snapshot(pc: &PermCache, uid: i64, roles: &[Role], cats: &[Category], chans: &[Channel]) -> Value {
    let base = pc.base(uid);
    let channels: Vec<Value> = chans
        .iter()
        .filter_map(|c| {
            let p = pc.channel(uid, c.id);
            (p & perms::VIEW_CHANNEL != 0).then(|| {
                let mut v = serde_json::to_value(c).unwrap_or_default();
                v["perms"] = json!(p);
                v
            })
        })
        .collect();
    let manage = base & (perms::MANAGE_CHANNELS | perms::CREATE_CHANNELS) != 0;
    let categories: Vec<&Category> = cats
        .iter()
        .filter(|cat| manage || channels.iter().any(|c| c["category_id"].as_i64() == Some(cat.id)))
        .collect();
    json!({ "roles": roles, "categories": categories, "channels": channels, "perms": base, "is_owner": pc.is_owner(uid) })
}

pub fn ice_config(st: &AppState) -> Value {
    let m = &st.cfg.media;
    let turn = (m.turn_enabled)
        .then(|| auth::turn_credentials(&st.turn_secret, 12 * 3600))
        .flatten()
        .map(|(u, p)| {
            let public = st.turn_public.read().unwrap_or_else(|e| e.into_inner()).clone();
            json!({ "port": m.udp_port, "tcp": true, "public": public, "username": u, "credential": p })
        });
    json!({
        "stun_port": (m.stun_enabled || m.turn_enabled).then_some(m.udp_port),
        "turn": turn,
        "servers": m.ice_servers,
    })
}

pub fn server_public(st: &AppState) -> Value {
    let s = st.settings();
    json!({
        "name": s.name,
        "description": s.description,
        "icon": s.icon,
        "registration_mode": s.registration_mode,
        "uploads_enabled": s.uploads_enabled,
        "max_upload_mb": s.max_upload_mb,
        "max_message_len": ops_chat::MAX_MESSAGE_LEN,
        "version": crate::VERSION,
        "protocol": crate::PROTOCOL,
        "max_voice_participants": st.cfg.media.max_voice_participants,
    })
}

async fn build_ready(st: &Arc<AppState>, user: &User) -> ApiResult<Value> {
    let uid = user.id;
    let (roles, cats, chans, members, dms, reads, mentions, rels) = st
        .db
        .call(move |c| {
            Ok((
                store::list_roles(c)?,
                store::list_categories(c)?,
                store::list_channels(c)?,
                store::users_with_status(c, "active")?,
                store::list_dms(c, uid)?,
                store::read_states(c, uid)?,
                store::mention_counts(c, uid)?,
                store::relationships(c, uid)?,
            ))
        })
        .await?;
    let pc = st.perms();
    let guild = guild_snapshot(&pc, uid, &roles, &cats, &chans);
    let members: Vec<Value> = members.iter().map(|u| member_json(st, &pc, u)).collect();
    let voice = ops_voice::visible_states(st, &pc, uid);
    let mut me = serde_json::to_value(user).unwrap_or_default();
    me["presence"] = json!(user.presence_pref);
    Ok(json!({
        "protocol": crate::PROTOCOL,
        "me": me,
        "server": server_public(st),
        "guild": guild,
        "members": members,
        "dms": dms,
        "read_states": reads,
        "mention_counts": mentions,
        "relationships": rels.into_iter().map(|(id, kind)| json!({ "user_id": id, "kind": kind })).collect::<Vec<_>>(),
        "voice": voice,
        "ice": ice_config(st),
    }))
}

pub fn broadcast_presence(st: &AppState, uid: i64) {
    let ev = hub::event("presence.update", &json!({ "user_id": uid, "presence": st.hub.public_presence(uid) }));
    st.hub.broadcast(&ev, |_| true);
}

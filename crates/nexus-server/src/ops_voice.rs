//! Voice channel membership and WebRTC signaling relay.
//!
//! The server only tracks who is in which voice channel and forwards SDP/ICE
//! messages between participants. Audio, video and screen streams flow
//! directly between clients (or via TURN), never through this process.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult, Code};
use crate::hub;
use crate::perms::{PermCache, CONNECT, MOVE_MEMBERS, MUTE_MEMBERS, SCREEN_SHARE, SPEAK, VIDEO, VIEW_CHANNEL};
use crate::util::now_ms;
use crate::ws::{ice_config, parse, Ctx};
use crate::AppState;

/// How long a participant whose connection dropped keeps their seat.
pub const RECONNECT_GRACE: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize)]
pub struct VoiceMember {
    pub user_id: i64,
    pub channel_id: i64,
    #[serde(skip)]
    pub conn_id: u64,
    pub muted: bool,
    pub deafened: bool,
    pub video: bool,
    pub screen: bool,
    /// The user lacks the SPEAK permission and is listen-only.
    pub suppressed: bool,
    /// Muted / deafened by a moderator (only they can lift it).
    pub server_muted: bool,
    pub server_deafened: bool,
    /// Raised hand (ms since epoch when raised), for "Hand heben".
    pub hand: Option<i64>,
    pub joined_at: i64,
}

#[derive(Default)]
pub struct VoiceRegistry {
    by_user: HashMap<i64, VoiceMember>,
    /// Soundboard: last sound per user (ms) for rate limiting.
    last_sound: HashMap<i64, i64>,
    /// Call reactions: last reaction per user (ms).
    last_reaction: HashMap<i64, i64>,
}

impl VoiceRegistry {
    pub fn count(&self) -> usize {
        self.by_user.len()
    }
    pub fn channel_members(&self, channel_id: i64) -> Vec<VoiceMember> {
        let mut v: Vec<VoiceMember> = self.by_user.values().filter(|m| m.channel_id == channel_id).cloned().collect();
        v.sort_by_key(|m| m.joined_at);
        v
    }
    pub fn get(&self, user_id: i64) -> Option<&VoiceMember> {
        self.by_user.get(&user_id)
    }
}

fn registry(st: &AppState) -> std::sync::MutexGuard<'_, VoiceRegistry> {
    st.voice.lock().unwrap_or_else(|p| p.into_inner())
}

fn broadcast_state(st: &AppState, m: &VoiceMember, left: bool) {
    let mut v = serde_json::to_value(m).unwrap_or_default();
    v["left"] = json!(left);
    st.broadcast_channel(m.channel_id, &hub::event("voice.state", &v));
}

pub fn visible_states(st: &AppState, pc: &PermCache, uid: i64) -> Vec<VoiceMember> {
    registry(st).by_user.values().filter(|m| pc.has_in(uid, m.channel_id, VIEW_CHANNEL)).cloned().collect()
}

#[derive(Deserialize)]
struct JoinReq {
    channel_id: i64,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    deafened: bool,
}

pub async fn join(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: JoinReq = parse(d)?;
    let (is_voice, can_speak, user_limit, can_move) = {
        let pc = ctx.perms();
        let ch = pc.channels.get(&r.channel_id);
        let is_voice = ch.map(|c| c.voice).unwrap_or(false);
        let limit = ch.map(|c| c.user_limit).unwrap_or(0);
        (is_voice, pc.has_in(ctx.uid, r.channel_id, SPEAK), limit, pc.has(ctx.uid, MOVE_MEMBERS))
    };
    ctx.require_in(r.channel_id, CONNECT)?;
    if !is_voice {
        return Err(ApiError::invalid("Kein Sprachkanal"));
    }
    let max = ctx.st.cfg.media.max_voice_participants;
    let (member, previous) = {
        let mut reg = registry(&ctx.st);
        if let Some(existing) = reg.by_user.get_mut(&ctx.uid) {
            if existing.channel_id == r.channel_id {
                // Same channel: a reconnect (or second device taking over).
                existing.conn_id = ctx.conn_id;
                let m = existing.clone();
                let participants = reg.channel_members(r.channel_id);
                drop(reg);
                broadcast_state(&ctx.st, &m, false);
                return Ok(json!({ "channel_id": r.channel_id, "participants": participants, "ice": ice_config(&ctx.st), "self": m }));
            }
        }
        if reg.channel_members(r.channel_id).len() >= max {
            return Err(ApiError::new(Code::VoiceFull, format!("Sprachkanal ist voll ({max} Teilnehmer)")));
        }
        if user_limit > 0 && !can_move && reg.channel_members(r.channel_id).len() as i64 >= user_limit {
            return Err(ApiError::new(Code::VoiceFull, format!("Sprachkanal ist voll (Limit {user_limit})")));
        }
        let previous = reg.by_user.remove(&ctx.uid);
        let m = VoiceMember {
            user_id: ctx.uid,
            channel_id: r.channel_id,
            conn_id: ctx.conn_id,
            muted: r.muted || !can_speak,
            deafened: r.deafened,
            video: false,
            screen: false,
            suppressed: !can_speak,
            server_muted: false,
            server_deafened: false,
            hand: None,
            joined_at: now_ms(),
        };
        reg.by_user.insert(ctx.uid, m.clone());
        (m, previous)
    };
    if let Some(p) = previous {
        broadcast_state(&ctx.st, &p, true);
    }
    broadcast_state(&ctx.st, &member, false);
    let participants = registry(&ctx.st).channel_members(r.channel_id);
    Ok(json!({ "channel_id": r.channel_id, "participants": participants, "ice": ice_config(&ctx.st), "self": member }))
}

pub async fn leave(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    force_leave(&ctx.st, ctx.uid);
    Ok(json!({}))
}

pub fn force_leave(st: &AppState, uid: i64) {
    let removed = registry(st).by_user.remove(&uid);
    if let Some(m) = removed {
        broadcast_state(st, &m, true);
    }
}

#[derive(Deserialize)]
struct UpdateReq {
    hand: Option<bool>,
    muted: Option<bool>,
    deafened: Option<bool>,
    video: Option<bool>,
    screen: Option<bool>,
}

pub async fn update(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: UpdateReq = parse(d)?;
    let channel_id = registry(&ctx.st).get(ctx.uid).map(|m| m.channel_id).ok_or_else(|| ApiError::not_found("Sprachverbindung"))?;
    if r.video == Some(true) {
        ctx.require_in(channel_id, VIDEO)?;
    }
    if r.screen == Some(true) {
        ctx.require_in(channel_id, SCREEN_SHARE)?;
    }
    let can_speak = ctx.perms().has_in(ctx.uid, channel_id, SPEAK);
    let m = {
        let mut reg = registry(&ctx.st);
        let m = reg.by_user.get_mut(&ctx.uid).ok_or_else(|| ApiError::not_found("Sprachverbindung"))?;
        if let Some(v) = r.muted {
            m.muted = v || !can_speak || m.server_muted;
        }
        if let Some(v) = r.deafened {
            m.deafened = v || m.server_deafened;
        }
        if let Some(v) = r.video {
            m.video = v;
        }
        if let Some(v) = r.screen {
            m.screen = v;
        }
        if let Some(v) = r.hand {
            m.hand = if v { m.hand.or(Some(now_ms())) } else { None };
        }
        m.suppressed = !can_speak;
        m.clone()
    };
    broadcast_state(&ctx.st, &m, false);
    Ok(json!(m))
}

/// Re-evaluates SPEAK for a participant (e.g. after a timeout was set or lifted).
pub fn refresh_speak(st: &AppState, uid: i64) {
    let m = {
        let pc = st.perms();
        let mut reg = registry(st);
        let Some(m) = reg.by_user.get_mut(&uid) else { return };
        let can_speak = pc.has_in(uid, m.channel_id, SPEAK);
        m.suppressed = !can_speak;
        if !can_speak {
            m.muted = true;
        }
        m.clone()
    };
    broadcast_state(st, &m, false);
}

#[derive(Deserialize)]
struct ModerateReq {
    user_id: i64,
    mute: Option<bool>,
    deafen: Option<bool>,
}

/// Server mute / deafen by a moderator.
pub async fn moderate(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ModerateReq = parse(d)?;
    let channel_id = registry(&ctx.st).get(r.user_id).map(|m| m.channel_id).ok_or_else(|| ApiError::not_found("Teilnehmer"))?;
    ctx.require_in(channel_id, MUTE_MEMBERS)?;
    {
        let pc = ctx.perms();
        if r.user_id != ctx.uid && (pc.is_owner(r.user_id) || !pc.outranks(ctx.uid, r.user_id)) {
            return Err(ApiError::new(Code::PermissionDenied, "Du kannst nur Benutzer unterhalb deiner Rolle moderieren"));
        }
    }
    let m = {
        let mut reg = registry(&ctx.st);
        let m = reg.by_user.get_mut(&r.user_id).ok_or_else(|| ApiError::not_found("Teilnehmer"))?;
        if let Some(v) = r.mute {
            m.server_muted = v;
            if v {
                m.muted = true;
            }
        }
        if let Some(v) = r.deafen {
            m.server_deafened = v;
            if v {
                m.deafened = true;
            }
        }
        m.clone()
    };
    ctx.audit("voice.moderate", format!("user:{}", r.user_id), format!("mute:{:?} deafen:{:?}", r.mute, r.deafen));
    broadcast_state(&ctx.st, &m, false);
    Ok(json!(m))
}

#[derive(Deserialize)]
struct MoveReq {
    user_id: i64,
    /// Target voice channel; `None` disconnects.
    channel_id: Option<i64>,
}

/// Moves a participant to another voice channel or disconnects them.
pub async fn move_member(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: MoveReq = parse(d)?;
    ctx.require(MOVE_MEMBERS)?;
    let current = registry(&ctx.st).get(r.user_id).map(|m| m.channel_id).ok_or_else(|| ApiError::not_found("Teilnehmer"))?;
    {
        let pc = ctx.perms();
        if r.user_id != ctx.uid && (pc.is_owner(r.user_id) || !pc.outranks(ctx.uid, r.user_id)) {
            return Err(ApiError::new(Code::PermissionDenied, "Du kannst nur Benutzer unterhalb deiner Rolle moderieren"));
        }
        if let Some(to) = r.channel_id {
            let ok = pc.channels.get(&to).is_some_and(|c| c.voice && !c.is_dm) && pc.has_in(r.user_id, to, CONNECT);
            if !ok || to == current {
                return Err(ApiError::invalid("Zielkanal ist kein erreichbarer Sprachkanal"));
            }
        }
    }
    // The client switches channels on this event; the seat is freed right away.
    ctx.st.hub.send_user(r.user_id, &hub::event("voice.moved", &json!({ "channel_id": r.channel_id, "by": ctx.uid })));
    force_leave(&ctx.st, r.user_id);
    ctx.audit("voice.move", format!("user:{}", r.user_id), format!("{current} -> {:?}", r.channel_id));
    Ok(json!({}))
}

/// Soundboard: at most one sound every few seconds per member.
pub const SOUND_INTERVAL_MS: i64 = 300;

#[derive(Deserialize)]
struct SoundReq {
    sound: String,
}

/// Plays a soundboard sound for everyone in the caller's voice channel.
pub async fn sound(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SoundReq = parse(d)?;
    if r.sound.is_empty() || r.sound.len() > 24 || !r.sound.bytes().all(|b| b.is_ascii_lowercase() || b == b'_') {
        return Err(ApiError::invalid("Unbekannter Sound"));
    }
    let channel_id = {
        let mut reg = registry(&ctx.st);
        let m = reg.by_user.get(&ctx.uid).ok_or_else(|| ApiError::not_found("Sprachverbindung"))?;
        if m.suppressed || m.server_muted {
            return Err(ApiError::denied());
        }
        let cid = m.channel_id;
        let now = now_ms();
        if reg.last_sound.get(&ctx.uid).is_some_and(|t| now - t < SOUND_INTERVAL_MS) {
            return Err(ApiError::rate_limited());
        }
        reg.last_sound.insert(ctx.uid, now);
        cid
    };
    ctx.require_in(channel_id, SPEAK)?;
    let ev = hub::event("voice.sound", &json!({ "channel_id": channel_id, "user_id": ctx.uid, "sound": r.sound }));
    ctx.st.broadcast_channel(channel_id, &ev);
    Ok(json!({}))
}

/// Call reactions: one every 600 ms per member.
pub const REACTION_INTERVAL_MS: i64 = 600;

#[derive(Deserialize)]
struct ReactReq {
    emoji: String,
}

/// Floating emoji reaction over the caller's tile, for everyone in the call.
pub async fn react(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ReactReq = parse(d)?;
    if !crate::ops_chat::valid_emoji(&r.emoji) {
        return Err(ApiError::invalid("Ungültiges Emoji"));
    }
    let channel_id = {
        let mut reg = registry(&ctx.st);
        let cid = reg.by_user.get(&ctx.uid).map(|m| m.channel_id).ok_or_else(|| ApiError::not_found("Sprachverbindung"))?;
        let now = now_ms();
        if reg.last_reaction.get(&ctx.uid).is_some_and(|t| now - t < REACTION_INTERVAL_MS) {
            return Err(ApiError::rate_limited());
        }
        reg.last_reaction.insert(ctx.uid, now);
        cid
    };
    let ev = hub::event("voice.reaction", &json!({ "channel_id": channel_id, "user_id": ctx.uid, "emoji": r.emoji }));
    ctx.st.broadcast_channel(channel_id, &ev);
    Ok(json!({}))
}

#[derive(Deserialize)]
struct SignalReq {
    to: i64,
    data: Value,
}

/// Relays an SDP offer/answer or ICE candidate to another participant of the
/// same voice channel.
pub async fn signal(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SignalReq = parse(d)?;
    let target_conn = {
        let reg = registry(&ctx.st);
        let me = reg.get(ctx.uid).ok_or_else(|| ApiError::not_found("Sprachverbindung"))?;
        let other = reg.get(r.to).filter(|o| o.channel_id == me.channel_id).ok_or_else(|| ApiError::not_found("Teilnehmer"))?;
        other.conn_id
    };
    if target_conn == 0 {
        return Err(ApiError::new(Code::NotFound, "Teilnehmer ist kurzzeitig nicht verbunden"));
    }
    let ev = hub::event("rtc.signal", &json!({ "from": ctx.uid, "data": r.data }));
    ctx.st.hub.send_conn(target_conn, &ev);
    Ok(json!({}))
}

/// Called when a WebSocket closes. The voice seat is kept for a short grace
/// period so a brief network drop does not tear down running media sessions.
pub fn on_disconnect(st: &Arc<AppState>, uid: i64, conn_id: u64) {
    {
        let mut reg = registry(st);
        match reg.by_user.get_mut(&uid) {
            Some(m) if m.conn_id == conn_id => m.conn_id = 0,
            _ => return,
        }
    }
    let st = st.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RECONNECT_GRACE).await;
        let removed = {
            let mut reg = registry(&st);
            match reg.by_user.get(&uid) {
                Some(m) if m.conn_id == 0 => reg.by_user.remove(&uid),
                _ => None,
            }
        };
        if let Some(m) = removed {
            tracing::debug!(user = uid, "voice seat released after disconnect");
            broadcast_state(&st, &m, true);
        }
    });
}

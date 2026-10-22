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
use crate::perms::{PermCache, CONNECT, SCREEN_SHARE, SPEAK, VIDEO, VIEW_CHANNEL};
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
    pub joined_at: i64,
}

#[derive(Default)]
pub struct VoiceRegistry {
    by_user: HashMap<i64, VoiceMember>,
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
    let (is_voice, can_speak) = {
        let pc = ctx.perms();
        let is_voice = pc.channels.get(&r.channel_id).map(|c| c.voice).unwrap_or(false);
        (is_voice, pc.has_in(ctx.uid, r.channel_id, SPEAK))
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
            m.muted = v || !can_speak;
        }
        if let Some(v) = r.deafened {
            m.deafened = v;
        }
        if let Some(v) = r.video {
            m.video = v;
        }
        if let Some(v) = r.screen {
            m.screen = v;
        }
        m.suppressed = !can_speak;
        m.clone()
    };
    broadcast_state(&ctx.st, &m, false);
    Ok(json!(m))
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

//! Per-user handling of direct messages: archive, pin, "delete for me" and
//! read receipts.
//!
//! "Delete for me" never removes messages from the database – the other person
//! keeps the conversation. It stores a marker; older messages are no longer
//! sent to this user (history, search) and the chat stays hidden until a newer
//! message arrives.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult};
use crate::ws::{parse, Ctx};
use crate::{hub, store, AppState};

#[derive(Deserialize)]
struct PrefsReq {
    channel_id: i64,
    archived: Option<bool>,
    pinned: Option<bool>,
}

/// `dm.prefs`: archive or pin a chat (only for yourself).
pub async fn prefs(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: PrefsReq = parse(d)?;
    if r.archived.is_none() && r.pinned.is_none() {
        return Err(ApiError::invalid("Nichts zu ändern"));
    }
    let (uid, cid) = (ctx.uid, r.channel_id);
    let ok = ctx.st.db.call(move |c| store::set_dm_flags(c, uid, cid, r.archived, r.pinned)).await?;
    if !ok {
        return Err(ApiError::not_found("Unterhaltung"));
    }
    let mut ev = json!({ "channel_id": cid });
    if let Some(a) = r.archived {
        ev["archived"] = json!(a);
    }
    if let Some(p) = r.pinned {
        ev["pinned"] = json!(p);
    }
    ctx.st.hub.send_user(uid, &hub::event("dm.prefs", &ev));
    Ok(ev)
}

#[derive(Deserialize)]
struct ChannelReq {
    channel_id: i64,
}

/// `dm.clear`: delete the chat for yourself (the other person keeps it).
pub async fn clear(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ChannelReq = parse(d)?;
    let (uid, cid) = (ctx.uid, r.channel_id);
    let marker = ctx.st.db.call(move |c| store::clear_dm(c, uid, cid)).await?.ok_or_else(|| ApiError::not_found("Unterhaltung"))?;
    let ev = json!({ "channel_id": cid, "cleared_before": marker });
    ctx.st.hub.send_user(uid, &hub::event("dm.cleared", &ev));
    Ok(ev)
}

#[derive(Deserialize)]
struct ReceiptsReq {
    enabled: bool,
}

/// `user.read_receipts`: share read receipts in DMs (both sides must allow it).
pub async fn set_receipts(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: ReceiptsReq = parse(d)?;
    let uid = ctx.uid;
    ctx.st.db.call(move |c| store::set_read_receipts(c, uid, r.enabled)).await?;
    ctx.st.hub.send_user(uid, &hub::event("user.read_receipts", &json!({ "enabled": r.enabled })));
    Ok(json!({ "enabled": r.enabled }))
}

/// After `channel.ack` in a DM: tells the other person how far you have read,
/// if both of you allow read receipts.
pub async fn after_ack(st: &AppState, uid: i64, channel_id: i64, message_id: i64) {
    let res = st
        .db
        .call(move |c| {
            let members = store::dm_members(c, channel_id)?;
            if members.len() != 2 || !store::read_receipts(c, uid)? {
                return Ok(None);
            }
            match members.into_iter().find(|m| *m != uid) {
                Some(o) if store::read_receipts(c, o)? => Ok(Some(o)),
                _ => Ok(None),
            }
        })
        .await;
    if let Ok(Some(other)) = res {
        st.hub.send_user(other, &hub::event("dm.read", &json!({ "channel_id": channel_id, "user_id": uid, "message_id": message_id })));
    }
}

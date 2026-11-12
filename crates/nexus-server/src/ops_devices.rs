//! Signed-in devices: link a second device with a one-time code (shown as a QR
//! code), list the devices of the own account and sign single devices out.
//!
//! A link code never contains the session token of the device that shows it:
//! redeeming it creates a new, separate session for the new device, which can
//! be signed out on its own.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult, Code};
use crate::util::{clean_text, now_ms, random_code};
use crate::ws::{parse, Ctx};
use crate::{hub, store, AppState};

/// How long a link code can be used.
pub const LINK_TTL_MS: i64 = 3 * 60 * 1000;
/// Length of a link code (32-character alphabet → 100 bits).
const LINK_LEN: usize = 20;

struct Link {
    uid: i64,
    expires: i64,
}

/// Open link codes. Kept in memory only: a server restart invalidates them.
#[derive(Default)]
pub struct Links(Mutex<HashMap<String, Link>>);

impl Links {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Link>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// A fresh code for `uid`; earlier codes of that user stop working.
    pub fn create(&self, uid: i64) -> (String, i64) {
        let now = now_ms();
        let mut m = self.lock();
        m.retain(|_, l| l.uid != uid && l.expires > now);
        let code = random_code(LINK_LEN);
        let expires = now + LINK_TTL_MS;
        m.insert(code.clone(), Link { uid, expires });
        (code, expires)
    }

    /// Consumes a code: returns the user once, then never again.
    pub fn redeem(&self, code: &str) -> Option<i64> {
        let mut m = self.lock();
        let l = m.remove(code.trim())?;
        (l.expires > now_ms()).then_some(l.uid)
    }
}

/// `device.link_create`: a one-time code to sign in another device.
pub async fn link_create(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    let (code, expires) = ctx.st.links.create(ctx.uid);
    tracing::info!(user = %ctx.username, "device link code created");
    Ok(json!({ "code": code, "expires_at": expires }))
}

/// A short, stable id for a session (never the token or its full hash).
fn session_id(hash: &[u8]) -> String {
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// `device.list`: the signed-in devices of the own account.
pub async fn list(ctx: &mut Ctx, _d: Value) -> ApiResult<Value> {
    let uid = ctx.uid;
    let me = session_id(&ctx.token_hash);
    let rows = ctx.st.db.call(move |c| store::user_sessions(c, uid)).await?;
    let list: Vec<Value> = rows
        .into_iter()
        .map(|s| {
            let id = session_id(&s.token_hash);
            json!({ "id": id, "device": s.device, "created_at": s.created_at, "last_seen": s.last_seen, "current": id == me })
        })
        .collect();
    Ok(json!({ "devices": list }))
}

#[derive(Deserialize)]
struct RevokeReq {
    id: String,
}

/// `device.revoke`: signs one device of the own account out.
pub async fn revoke(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: RevokeReq = parse(d)?;
    if session_id(&ctx.token_hash) == r.id {
        return Err(ApiError::invalid("Dieses Gerät meldest du über „Abmelden“ ab"));
    }
    let uid = ctx.uid;
    let rows = ctx.st.db.call(move |c| store::user_sessions(c, uid)).await?;
    let target = rows.into_iter().find(|s| session_id(&s.token_hash) == r.id).ok_or_else(|| ApiError::not_found("Gerät"))?;
    let th = target.token_hash.clone();
    ctx.st.db.call(move |c| store::delete_session(c, &th)).await?;
    // Only the revoked device is disconnected (and told its session is gone).
    ctx.st.hub.disconnect_session(uid, &target.token_hash, 4001, "session revoked");
    let dev = target.device.clone();
    ctx.st.db.call(move |c| {
        store::audit(c, Some(uid), "session.revoke", &format!("user:{uid}"), &dev);
        Ok(())
    })
    .await?;
    Ok(json!({}))
}

/// HTTP `POST /api/v1/auth/link`: redeem a link code for a new session.
pub async fn redeem(st: &AppState, code: &str, device: &str) -> ApiResult<(String, store::User)> {
    let device = clean_text(device, 64, false, "Gerät").unwrap_or_default();
    let uid = st.links.redeem(code).ok_or_else(|| ApiError::new(Code::InvalidCredentials, "Der Code ist ungültig oder abgelaufen"))?;
    let user = st.db.call(move |c| store::user_by_id(c, uid)).await?.ok_or_else(|| ApiError::new(Code::InvalidCredentials, "Konto nicht gefunden"))?;
    if user.status != "active" {
        return Err(ApiError::new(Code::InvalidCredentials, "Konto ist nicht aktiv"));
    }
    let token = crate::util::random_token();
    let th = crate::auth::token_hash(&token);
    let dev = device.clone();
    st.db.call(move |c| store::create_session(c, uid, &th, &dev)).await?;
    st.hub.send_user(uid, &hub::event("device.linked", &json!({ "device": device })));
    tracing::info!(user = %user.username, %device, "device linked");
    Ok((token, user))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_single_use_and_replace_older_ones() {
        let links = Links::default();
        let (a, _) = links.create(7);
        let (b, _) = links.create(7);
        assert_eq!(a.len(), LINK_LEN);
        assert_eq!(links.redeem(&a), None, "an older code stops working");
        assert_eq!(links.redeem(&b), Some(7));
        assert_eq!(links.redeem(&b), None, "a code works only once");
        let (c, _) = links.create(8);
        links.lock().get_mut(&c).unwrap().expires = now_ms() - 1;
        assert_eq!(links.redeem(&c), None, "an expired code is refused");
    }
}

//! Text chat operations: send, edit, delete, history, search, read state, typing.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{ApiError, ApiResult, Code};
use crate::hub;
use crate::perms::{ATTACH_FILES, MANAGE_MESSAGES, SEND_MESSAGES, VIEW_CHANNEL};
use crate::store;
use crate::util::clean_text;
use crate::ws::{parse, Ctx};
use crate::files;

pub const MAX_MESSAGE_LEN: usize = 4000;
pub const MAX_ATTACHMENTS: usize = 10;

/// Extracts `@name` mentions (distinct, at most 20).
pub fn parse_mentions(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '@' && (i == 0 || !(chars[i - 1].is_alphanumeric() || chars[i - 1] == '_')) {
            let start = i + 1;
            let mut j = start;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || matches!(chars[j], '_' | '-' | '.')) {
                j += 1;
            }
            let mut name: String = chars[start..j].iter().collect();
            while name.ends_with('.') || name.ends_with('-') {
                name.pop();
            }
            if (2..=32).contains(&name.len()) && !out.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                out.push(name);
                if out.len() >= 20 {
                    break;
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

async fn resolve_mentions(ctx: &Ctx, channel_id: i64, content: &str) -> ApiResult<Vec<i64>> {
    let names = parse_mentions(content);
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let ids = ctx
        .st
        .db
        .call(move |c| {
            let mut v = Vec::new();
            for n in names {
                if let Some((u, _)) = store::user_by_name(c, &n)? {
                    if u.status == "active" {
                        v.push(u.id);
                    }
                }
            }
            Ok(v)
        })
        .await?;
    let pc = ctx.perms();
    Ok(ids.into_iter().filter(|u| pc.has_in(*u, channel_id, VIEW_CHANNEL)).collect())
}

fn dm_partner(ctx: &Ctx, channel_id: i64) -> Option<i64> {
    let pc = ctx.perms();
    let ch = pc.channels.get(&channel_id)?;
    if !ch.is_dm {
        return None;
    }
    ch.dm_members.iter().copied().find(|u| *u != ctx.uid)
}

#[derive(Deserialize)]
struct SendReq {
    channel_id: i64,
    #[serde(default)]
    content: String,
    reply_to: Option<i64>,
    #[serde(default)]
    attachments: Vec<String>,
    nonce: Option<String>,
}

pub async fn send(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SendReq = parse(d)?;
    ctx.take_message_token()?;
    ctx.require_in(r.channel_id, SEND_MESSAGES)?;
    if !r.attachments.is_empty() {
        ctx.require_in(r.channel_id, ATTACH_FILES)?;
        if r.attachments.len() > MAX_ATTACHMENTS {
            return Err(ApiError::invalid(format!("Höchstens {MAX_ATTACHMENTS} Anhänge pro Nachricht")));
        }
    }
    let content = clean_text(&r.content, MAX_MESSAGE_LEN, true, "Nachricht")?;
    if content.is_empty() && r.attachments.is_empty() {
        return Err(ApiError::invalid("Nachricht ist leer"));
    }
    let nonce = r.nonce.map(|n| n.chars().take(64).collect::<String>());
    if let Some(other) = dm_partner(ctx, r.channel_id) {
        let me = ctx.uid;
        if ctx.st.db.call(move |c| store::is_blocked_either(c, me, other)).await? {
            return Err(ApiError::new(Code::Blocked, "Nachricht kann nicht zugestellt werden"));
        }
    }
    let mentions = resolve_mentions(ctx, r.channel_id, &content).await?;
    let (uid, cid, reply, atts) = (ctx.uid, r.channel_id, r.reply_to, r.attachments);
    let msg = ctx
        .st
        .db
        .call(move |c| store::insert_message(c, cid, uid, &content, reply, &mentions, &atts))
        .await?;
    let ev = hub::event("message.created", &json!({ "message": msg, "nonce": nonce }));
    ctx.st.broadcast_channel(cid, &ev);
    Ok(json!(msg))
}

#[derive(Deserialize)]
struct EditReq {
    message_id: i64,
    content: String,
}

pub async fn edit(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: EditReq = parse(d)?;
    ctx.take_message_token()?;
    let id = r.message_id;
    let old = ctx.st.db.call(move |c| store::get_message(c, id)).await?.ok_or_else(|| ApiError::not_found("Nachricht"))?;
    ctx.require_in(old.channel_id, VIEW_CHANNEL)?;
    if old.author_id != ctx.uid {
        return Err(ApiError::new(Code::PermissionDenied, "Nur eigene Nachrichten können bearbeitet werden"));
    }
    let content = clean_text(&r.content, MAX_MESSAGE_LEN, true, "Nachricht")?;
    if content.is_empty() && old.attachments.is_empty() {
        return Err(ApiError::invalid("Nachricht ist leer"));
    }
    let mentions = resolve_mentions(ctx, old.channel_id, &content).await?;
    let msg = ctx.st.db.call(move |c| store::edit_message(c, id, &content, &mentions)).await?;
    ctx.st.broadcast_channel(msg.channel_id, &hub::event("message.updated", &msg));
    Ok(json!(msg))
}

#[derive(Deserialize)]
struct IdReq {
    message_id: i64,
}

pub async fn delete(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: IdReq = parse(d)?;
    let id = r.message_id;
    let old = ctx.st.db.call(move |c| store::get_message(c, id)).await?.ok_or_else(|| ApiError::not_found("Nachricht"))?;
    ctx.require_in(old.channel_id, VIEW_CHANNEL)?;
    let own = old.author_id == ctx.uid;
    if !own {
        ctx.require_in(old.channel_id, MANAGE_MESSAGES)?;
    }
    let files_to_remove = ctx.st.db.call(move |c| store::delete_message(c, id)).await?;
    files::remove_attachments(&ctx.st, &files_to_remove);
    ctx.st.broadcast_channel(
        old.channel_id,
        &hub::event("message.deleted", &json!({ "id": id, "channel_id": old.channel_id })),
    );
    if !own {
        ctx.audit("message.delete", format!("message:{id}"), format!("author:{} channel:{}", old.author_id, old.channel_id));
    }
    Ok(json!({}))
}

#[derive(Deserialize)]
struct HistoryReq {
    channel_id: i64,
    before: Option<i64>,
    after: Option<i64>,
    limit: Option<usize>,
}

pub async fn history(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: HistoryReq = parse(d)?;
    ctx.require_in(r.channel_id, VIEW_CHANNEL)?;
    let limit = r.limit.unwrap_or(50).clamp(1, 100);
    let msgs = ctx
        .st
        .db
        .call(move |c| match r.after {
            Some(a) => store::history_after(c, r.channel_id, a, limit),
            None => store::history(c, r.channel_id, r.before, limit),
        })
        .await?;
    Ok(json!({ "messages": msgs, "has_more": msgs.len() == limit }))
}

#[derive(Deserialize)]
struct SearchReq {
    query: String,
    channel_id: Option<i64>,
}

pub async fn search(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: SearchReq = parse(d)?;
    if r.query.chars().count() > 200 {
        return Err(ApiError::invalid("Suchbegriff ist zu lang"));
    }
    let channels: Vec<i64> = match r.channel_id {
        Some(c) => {
            ctx.require_in(c, VIEW_CHANNEL)?;
            vec![c]
        }
        None => ctx.perms().visible_channels(ctx.uid).collect(),
    };
    let q = r.query;
    let msgs = ctx.st.db.call(move |c| store::search(c, &q, &channels, 50)).await?;
    Ok(json!({ "messages": msgs }))
}

#[derive(Deserialize)]
struct AckReq {
    channel_id: i64,
    message_id: i64,
}

pub async fn ack(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: AckReq = parse(d)?;
    ctx.require_in(r.channel_id, VIEW_CHANNEL)?;
    let uid = ctx.uid;
    ctx.st.db.call(move |c| store::set_read(c, uid, r.channel_id, r.message_id)).await?;
    let ev = hub::event("read_state.update", &json!({ "channel_id": r.channel_id, "message_id": r.message_id }));
    ctx.st.hub.send_user_except(uid, ctx.conn_id, &ev);
    Ok(json!({}))
}

#[derive(Deserialize)]
struct TypingReq {
    channel_id: i64,
}

pub async fn typing(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: TypingReq = parse(d)?;
    ctx.require_in(r.channel_id, SEND_MESSAGES)?;
    let ev = hub::event("typing", &json!({ "channel_id": r.channel_id, "user_id": ctx.uid }));
    let pc = ctx.perms();
    let me = ctx.uid;
    ctx.st.hub.broadcast(&ev, |u| u != me && pc.has_in(u, r.channel_id, VIEW_CHANNEL));
    Ok(json!({}))
}

/// Accepts a single emoji (or short emoji sequence); rejects plain text.
pub fn valid_emoji(e: &str) -> bool {
    !e.is_empty()
        && e.len() <= 32
        && e.chars().all(|c| !c.is_whitespace() && !c.is_control())
        && e.chars().any(|c| !c.is_ascii())
        && e.chars().count() <= 8
}

#[derive(Deserialize)]
struct ReactionReq {
    message_id: i64,
    emoji: String,
}

async fn react(ctx: &mut Ctx, d: Value, add: bool) -> ApiResult<Value> {
    let r: ReactionReq = parse(d)?;
    if !valid_emoji(&r.emoji) {
        return Err(ApiError::invalid("Ungültiges Emoji"));
    }
    ctx.take_message_token()?;
    let id = r.message_id;
    let msg = ctx.st.db.call(move |c| store::get_message(c, id)).await?.ok_or_else(|| ApiError::not_found("Nachricht"))?;
    ctx.require_in(msg.channel_id, SEND_MESSAGES)?;
    let (uid, emoji) = (ctx.uid, r.emoji.clone());
    let changed = ctx.st.db.call(move |c| store::set_reaction(c, id, uid, &emoji, add)).await?;
    if changed {
        let ev = hub::event(
            "reaction.update",
            &json!({ "message_id": id, "channel_id": msg.channel_id, "emoji": r.emoji, "user_id": ctx.uid, "added": add }),
        );
        ctx.st.broadcast_channel(msg.channel_id, &ev);
    }
    Ok(json!({ "changed": changed }))
}

pub async fn reaction_add(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    react(ctx, d, true).await
}

pub async fn reaction_remove(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    react(ctx, d, false).await
}

#[derive(Deserialize)]
struct PinReq {
    message_id: i64,
    pinned: bool,
}

pub async fn pin(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: PinReq = parse(d)?;
    let id = r.message_id;
    let msg = ctx.st.db.call(move |c| store::get_message(c, id)).await?.ok_or_else(|| ApiError::not_found("Nachricht"))?;
    // In DMs both participants may pin; elsewhere it is a moderation right.
    if dm_partner(ctx, msg.channel_id).is_some() {
        ctx.require_in(msg.channel_id, VIEW_CHANNEL)?;
    } else {
        ctx.require_in(msg.channel_id, MANAGE_MESSAGES)?;
    }
    let pinned = r.pinned;
    let updated = ctx
        .st
        .db
        .call(move |c| {
            store::set_pinned(c, id, pinned)?;
            store::get_message(c, id)
        })
        .await?
        .ok_or_else(ApiError::internal)?;
    ctx.st.broadcast_channel(updated.channel_id, &hub::event("message.updated", &updated));
    Ok(json!(updated))
}

#[derive(Deserialize)]
struct PinsReq {
    channel_id: i64,
}

pub async fn pins(ctx: &mut Ctx, d: Value) -> ApiResult<Value> {
    let r: PinsReq = parse(d)?;
    ctx.require_in(r.channel_id, VIEW_CHANNEL)?;
    let msgs = ctx.st.db.call(move |c| store::pinned_messages(c, r.channel_id)).await?;
    Ok(json!({ "messages": msgs }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mention_parsing() {
        assert_eq!(parse_mentions("hi @anna and @ben."), vec!["anna", "ben"]);
        assert_eq!(parse_mentions("mail@example.com"), Vec::<String>::new());
        assert_eq!(parse_mentions("@Anna @anna @a"), vec!["Anna"]);
        assert_eq!(parse_mentions("(@max_1)"), vec!["max_1"]);
        assert_eq!(parse_mentions(&"@xx ".repeat(50)).len(), 1);
    }

    #[test]
    fn emoji_validation() {
        assert!(valid_emoji("👍"));
        assert!(valid_emoji("👨‍👩‍👧"));
        assert!(valid_emoji("❤️"));
        assert!(!valid_emoji("lol"));
        assert!(!valid_emoji(""));
        assert!(!valid_emoji("👍 👍"));
        assert!(!valid_emoji(&"😀".repeat(9)));
    }
}

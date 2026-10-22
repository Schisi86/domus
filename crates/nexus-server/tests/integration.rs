//! End-to-end tests: real server on a local port, real clients over HTTP and
//! WebSocket (via the same `nexus-net` crate the desktop app uses).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use nexus_net::{Endpoint, NetError, WsMessage, WsStream};
use nexus_server::config::Config;
use nexus_server::RunningServer;
use serde_json::{json, Value};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct TestServer {
    dir: PathBuf,
    cfg: Config,
    srv: Option<RunningServer>,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

impl TestServer {
    async fn start(name: &str, tls: bool) -> TestServer {
        let dir = std::env::temp_dir().join(format!("nx-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut cfg = Config::default();
        cfg.port = free_port();
        cfg.tls.enabled = tls;
        cfg.media.stun_enabled = false;
        let srv = nexus_server::start(cfg.clone(), &dir).await.expect("server start");
        TestServer { dir, cfg, srv: Some(srv) }
    }

    fn srv(&self) -> &RunningServer {
        self.srv.as_ref().unwrap()
    }

    fn address(&self) -> String {
        format!("{}://127.0.0.1:{}", if self.cfg.tls.enabled { "https" } else { "http" }, self.cfg.port)
    }

    fn endpoint(&self) -> Endpoint {
        Endpoint::new(&self.address(), self.srv().tls_fingerprint.as_deref()).unwrap()
    }

    async fn restart(&mut self) {
        self.srv.take().unwrap().shutdown().await;
        self.srv = Some(nexus_server::start(self.cfg.clone(), &self.dir).await.expect("restart"));
    }

    async fn stop(mut self) {
        if let Some(s) = self.srv.take() {
            s.shutdown().await;
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn post(ep: &Endpoint, path: &str, body: Value) -> (u16, Value) {
    let r = ep.request("POST", path, None, Some(body.to_string().into_bytes()), Some("application/json")).await.unwrap();
    (r.status, serde_json::from_slice(&r.body).unwrap_or(Value::Null))
}

async fn register(ep: &Endpoint, user: &str, invite: Option<&str>) -> (u16, Value) {
    post(ep, "/api/v1/auth/register", json!({ "username": user, "password": "geheim123", "invite": invite })).await
}

async fn login(ep: &Endpoint, user: &str, pw: &str) -> (u16, Value) {
    post(ep, "/api/v1/auth/login", json!({ "username": user, "password": pw })).await
}

struct Client {
    ws: WsStream,
    next: u64,
    events: VecDeque<Value>,
    token: String,
}

impl Client {
    async fn connect(ep: &Endpoint, token: &str) -> (Client, Value) {
        let ws = ep.connect_ws().await.expect("ws connect");
        let mut c = Client { ws, next: 0, events: VecDeque::new(), token: token.to_string() };
        let ready = c.req("auth", json!({ "token": token })).await.expect("auth ok");
        (c, ready)
    }

    async fn frame(&mut self, timeout: Duration) -> Option<Value> {
        loop {
            match tokio::time::timeout(timeout, self.ws.next()).await {
                Ok(Some(Ok(WsMessage::Text(t)))) => return serde_json::from_str(t.as_str()).ok(),
                Ok(Some(Ok(WsMessage::Close(_)))) | Ok(None) | Ok(Some(Err(_))) | Err(_) => return None,
                Ok(Some(Ok(_))) => continue,
            }
        }
    }

    async fn req(&mut self, op: &str, d: Value) -> Result<Value, Value> {
        self.next += 1;
        let id = self.next;
        self.ws.send(WsMessage::Text(json!({ "id": id, "op": op, "d": d }).to_string().into())).await.unwrap();
        loop {
            let f = self.frame(Duration::from_secs(10)).await.expect("response");
            if f["re"].as_u64() == Some(id) {
                return if f["ok"].as_bool() == Some(true) { Ok(f["d"].clone()) } else { Err(f["err"].clone()) };
            }
            if f.get("ev").is_some() {
                self.events.push_back(f);
            }
        }
    }

    async fn event(&mut self, name: &str) -> Value {
        if let Some(i) = self.events.iter().position(|e| e["ev"] == name) {
            return self.events.remove(i).unwrap()["d"].clone();
        }
        loop {
            let f = self.frame(Duration::from_secs(5)).await.unwrap_or_else(|| panic!("event {name} not received"));
            if f["ev"] == name {
                return f["d"].clone();
            }
            if f.get("ev").is_some() {
                self.events.push_back(f);
            }
        }
    }

    /// Drains pending frames and asserts no event with this name arrives.
    async fn assert_no_event(&mut self, name: &str) {
        while let Some(f) = self.frame(Duration::from_millis(400)).await {
            assert_ne!(f["ev"], name, "unexpected event {f}");
        }
        assert!(!self.events.iter().any(|e| e["ev"] == name));
    }
}

fn code(err: &Value) -> &str {
    err["code"].as_str().unwrap_or("")
}

/// Starts a server, creates the owner and a regular member. Returns tokens.
async fn setup(name: &str) -> (TestServer, Endpoint, String, String) {
    let ts = TestServer::start(name, false).await;
    let ep = ts.endpoint();
    let setup = ts.srv().setup_code.clone().expect("setup code on fresh server");
    let (s, owner) = register(&ep, "owner", Some(&setup)).await;
    assert_eq!(s, 200, "{owner}");
    let owner_token = owner["token"].as_str().unwrap().to_string();
    let (mut oc, _) = Client::connect(&ep, &owner_token).await;
    let inv = oc.req("invite.create", json!({ "max_uses": 5 })).await.unwrap();
    let code = inv["code"].as_str().unwrap();
    let (s, member) = register(&ep, "member", Some(code)).await;
    assert_eq!(s, 200, "{member}");
    (ts, ep, owner_token, member["token"].as_str().unwrap().to_string())
}

fn channel_id(ready: &Value, name: &str) -> i64 {
    ready["guild"]["channels"].as_array().unwrap().iter().find(|c| c["name"] == name).expect(name)["id"].as_i64().unwrap()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn owner_setup_registration_and_login() {
    let ts = TestServer::start("auth", false).await;
    let ep = ts.endpoint();
    let (s, info) = ep.request("GET", "/api/v1/info", None, None, None).await.map(|r| (r.status, r.body)).unwrap();
    assert_eq!(s, 200);
    let info: Value = serde_json::from_slice(&info).unwrap();
    assert_eq!(info["registration_mode"], "invite");

    // Without invite, registration is closed by default.
    let (s, e) = register(&ep, "eve", None).await;
    assert_eq!((s, code(&e["error"])), (403, "REGISTRATION_CLOSED"));
    let (s, e) = register(&ep, "eve", Some("WRONGCODE")).await;
    assert_eq!((s, code(&e["error"])), (400, "INVALID_INVITE"));

    let setup = ts.srv().setup_code.clone().unwrap();
    let (s, r) = register(&ep, "owner", Some(&setup)).await;
    assert_eq!(s, 200);
    assert_eq!(r["user"]["is_owner"], true);
    let (s, _) = register(&ep, "owner2", Some(&setup)).await;
    assert_eq!(s, 400, "setup code is single use");

    let (s, r) = login(&ep, "OWNER", "geheim123").await;
    assert_eq!(s, 200, "usernames are case-insensitive");
    assert!(r["token"].as_str().unwrap().len() > 30);
    assert!(r["user"].get("password_hash").is_none(), "hash never leaves the server");
    let (s, e) = login(&ep, "owner", "falsch-falsch").await;
    assert_eq!((s, code(&e["error"])), (401, "INVALID_CREDENTIALS"));
    let (s, e) = login(&ep, "nobody", "falsch-falsch").await;
    assert_eq!((s, code(&e["error"])), (401, "INVALID_CREDENTIALS"), "same error for unknown users");

    // Passwords are stored as Argon2id hashes only.
    let raw = std::fs::read(ts.dir.join("nexus.db")).unwrap_or_default();
    assert!(!String::from_utf8_lossy(&raw).contains("geheim123"));
    ts.stop().await;
}

#[tokio::test]
async fn invalid_session_is_rejected_on_websocket() {
    let ts = TestServer::start("badtoken", false).await;
    let ep = ts.endpoint();
    let mut ws = ep.connect_ws().await.unwrap();
    ws.send(WsMessage::Text(json!({ "id": 1, "op": "auth", "d": { "token": "forged" } }).to_string().into())).await.unwrap();
    let mut got_error = false;
    while let Ok(Some(Ok(m))) = tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
        match m {
            WsMessage::Text(t) => {
                let v: Value = serde_json::from_str(t.as_str()).unwrap();
                assert_eq!(v["ok"], false);
                assert_eq!(v["err"]["code"], "UNAUTHORIZED");
                got_error = true;
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }
    assert!(got_error);
    // Ops before auth are refused as well.
    let mut ws = ep.connect_ws().await.unwrap();
    ws.send(WsMessage::Text(json!({ "id": 1, "op": "message.history", "d": { "channel_id": 1 } }).to_string().into())).await.unwrap();
    let Some(Ok(WsMessage::Text(t))) = ws.next().await else { panic!("expected error frame") };
    assert!(t.as_str().contains("UNAUTHORIZED"));
    ts.stop().await;
}

#[tokio::test]
async fn text_chat_between_two_clients_survives_restart() {
    let (mut ts, ep, owner, member) = setup("chat").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let general = channel_id(&ready_a, "allgemein");
    assert_eq!(channel_id(&ready_b, "allgemein"), general);
    assert!(ready_a["members"].as_array().unwrap().len() >= 2);

    let sent = a
        .req("message.send", json!({ "channel_id": general, "content": "Hallo @member\nzweite Zeile", "nonce": "n1" }))
        .await
        .unwrap();
    let got = b.event("message.created").await;
    assert_eq!(got["message"]["id"], sent["id"]);
    assert_eq!(got["message"]["content"], "Hallo @member\nzweite Zeile");
    let member_id = ready_b["me"]["id"].as_i64().unwrap();
    assert_eq!(got["message"]["mentions"], json!([member_id]));

    // Reply, edit, typing.
    let reply = b.req("message.send", json!({ "channel_id": general, "content": "Antwort", "reply_to": sent["id"] })).await.unwrap();
    assert_eq!(reply["reply_preview"]["id"], sent["id"]);
    b.req("typing", json!({ "channel_id": general })).await.unwrap();
    assert_eq!(a.event("typing").await["user_id"], member_id);
    let e = b.req("message.edit", json!({ "message_id": sent["id"], "content": "gekapert" })).await.unwrap_err();
    assert_eq!(code(&e), "PERMISSION_DENIED", "cannot edit others' messages");
    a.req("message.edit", json!({ "message_id": sent["id"], "content": "Hallo (bearbeitet)" })).await.unwrap();
    assert_eq!(b.event("message.updated").await["content"], "Hallo (bearbeitet)");

    // Unread mention count is persisted per user.
    b.req("channel.ack", json!({ "channel_id": general, "message_id": reply["id"] })).await.unwrap();

    ts.restart().await;
    // Old connections are closed by the restart; reconnect with the same session.
    assert!(a.frame(Duration::from_secs(5)).await.is_none() || a.frame(Duration::from_secs(5)).await.is_none());
    let ep = ts.endpoint();
    let (mut b2, ready) = Client::connect(&ep, &member).await;
    assert_eq!(ready["read_states"][general.to_string()], reply["id"]);
    let h = b2.req("message.history", json!({ "channel_id": general })).await.unwrap();
    let msgs = h["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0]["content"], "Hallo (bearbeitet)");
    assert!(msgs[0]["edited_at"].is_i64());
    assert_eq!(msgs[1]["content"], "Antwort");

    // Search finds persisted messages.
    let s = b2.req("message.search", json!({ "query": "antw" })).await.unwrap();
    assert_eq!(s["messages"].as_array().unwrap().len(), 1);

    // Delete own message; others see the deletion.
    let (mut a2, _) = Client::connect(&ep, &owner).await;
    b2.req("message.delete", json!({ "message_id": reply["id"] })).await.unwrap();
    assert_eq!(a2.event("message.deleted").await["id"], reply["id"]);
    ts.stop().await;
}

#[tokio::test]
async fn permissions_are_enforced_by_the_server() {
    let (ts, ep, owner, member) = setup("perms").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let general = channel_id(&ready, "allgemein");

    // Members cannot manage the server.
    for (op, d) in [
        ("channel.create", json!({ "kind": "text", "name": "hack" })),
        ("role.create", json!({ "name": "root", "permissions": 1u64 << 30 })),
        ("server.update", json!({ "registration_mode": "open" })),
        ("server.logs", json!({})),
        ("backup.create", json!({})),
        ("invite.create", json!({})),
    ] {
        let e = b.req(op, d).await.unwrap_err();
        assert_eq!(code(&e), "PERMISSION_DENIED", "{op}");
    }
    let me = ready_b["me"]["id"].as_i64().unwrap();
    let roles = ready["guild"]["roles"].as_array().unwrap();
    let admin_role = roles.iter().find(|r| r["name"] == "Administrator").unwrap()["id"].clone();
    let e = b.req("member.set_roles", json!({ "user_id": me, "role_ids": [admin_role] })).await.unwrap_err();
    assert_eq!(code(&e), "PERMISSION_DENIED", "no self promotion");

    // A staff-only channel: hidden from members via override.
    let member_role = roles.iter().find(|r| r["name"] == "Mitglied").unwrap()["id"].as_i64().unwrap();
    let staff = a.req("channel.create", json!({ "kind": "text", "name": "Team Intern" })).await.unwrap();
    assert_eq!(staff["name"], "team-intern");
    let staff_id = staff["id"].as_i64().unwrap();
    a.req("channel.set_override", json!({ "channel_id": staff_id, "role_id": member_role, "allow": 0, "deny": 1 })).await.unwrap();
    // Several syncs may arrive (create, then override); the last one must hide the channel.
    loop {
        let sync = b.event("guild.sync").await;
        if !sync["channels"].as_array().unwrap().iter().any(|c| c["id"] == staff_id) {
            break;
        }
    }

    let e = b.req("message.history", json!({ "channel_id": staff_id })).await.unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    let e = b.req("message.send", json!({ "channel_id": staff_id, "content": "rein?" })).await.unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    a.req("message.send", json!({ "channel_id": staff_id, "content": "geheim" })).await.unwrap();
    let s = b.req("message.search", json!({ "query": "geheim" })).await.unwrap();
    assert!(s["messages"].as_array().unwrap().is_empty(), "search respects visibility");
    b.assert_no_event("message.created").await;

    // Read-only channel: deny SEND for members.
    a.req("channel.set_override", json!({ "channel_id": general, "role_id": member_role, "allow": 0, "deny": 2 })).await.unwrap();
    b.event("guild.sync").await;
    let e = b.req("message.send", json!({ "channel_id": general, "content": "x" })).await.unwrap_err();
    assert_eq!(code(&e), "PERMISSION_DENIED");

    // Moderation: members cannot delete others' messages, the owner can.
    a.req("channel.set_override", json!({ "channel_id": general, "role_id": member_role, "allow": 0, "deny": 0 })).await.unwrap();
    b.event("guild.sync").await;
    let m = b.req("message.send", json!({ "channel_id": general, "content": "spam" })).await.unwrap();
    let om = a.req("message.send", json!({ "channel_id": general, "content": "owner" })).await.unwrap();
    let e = b.req("message.delete", json!({ "message_id": om["id"] })).await.unwrap_err();
    assert_eq!(code(&e), "PERMISSION_DENIED");
    a.req("message.delete", json!({ "message_id": m["id"] })).await.unwrap();
    let audit = a.req("audit.list", json!({})).await.unwrap();
    assert!(audit.as_array().unwrap().iter().any(|e| e["action"] == "message.delete"));
    ts.stop().await;
}

#[tokio::test]
async fn ban_disconnects_and_blocks_login() {
    let (ts, ep, owner, member) = setup("ban").await;
    let (mut a, _) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let uid = ready_b["me"]["id"].as_i64().unwrap();
    a.req("member.ban", json!({ "user_id": uid, "reason": "Test" })).await.unwrap();
    // The banned client's socket is closed.
    let mut closed = false;
    for _ in 0..10 {
        if b.frame(Duration::from_secs(2)).await.is_none() {
            closed = true;
            break;
        }
    }
    assert!(closed);
    let (s, e) = login(&ep, "member", "geheim123").await;
    assert_eq!((s, code(&e["error"])), (403, "ACCOUNT_BANNED"));
    let ws = ep.connect_ws().await.unwrap();
    let mut c = Client { ws, next: 0, events: VecDeque::new(), token: member.clone() };
    assert_eq!(code(&c.req("auth", json!({ "token": member })).await.unwrap_err()), "UNAUTHORIZED", "sessions revoked");
    let _ = c.token;
    a.req("member.unban", json!({ "user_id": uid })).await.unwrap();
    assert_eq!(login(&ep, "member", "geheim123").await.0, 200);
    ts.stop().await;
}

#[tokio::test]
async fn approval_mode_requires_moderator() {
    let (ts, ep, owner, _) = setup("approval").await;
    let (mut a, _) = Client::connect(&ep, &owner).await;
    a.req("server.update", json!({ "registration_mode": "approval" })).await.unwrap();
    let (s, r) = register(&ep, "neuling", None).await;
    assert_eq!(s, 200);
    assert_eq!(r["pending"], true);
    assert!(r.get("token").is_none());
    let (s, e) = login(&ep, "neuling", "geheim123").await;
    assert_eq!((s, code(&e["error"])), (403, "ACCOUNT_PENDING"));
    let pending = a.req("member.list_status", json!({ "status": "pending" })).await.unwrap();
    let id = pending[0]["id"].clone();
    a.req("member.approve", json!({ "user_id": id })).await.unwrap();
    assert_eq!(login(&ep, "neuling", "geheim123").await.0, 200);
    ts.stop().await;
}

#[tokio::test]
async fn manipulated_and_oversized_input_is_rejected() {
    let (ts, ep, _owner, member) = setup("input").await;
    let (mut b, ready) = Client::connect(&ep, &member).await;
    let general = channel_id(&ready, "allgemein");

    b.ws.send(WsMessage::Text("{not json".into())).await.unwrap();
    loop {
        let f = b.frame(Duration::from_secs(5)).await.unwrap();
        if f.get("err").is_some() {
            assert_eq!(f["err"]["code"], "BAD_REQUEST");
            break;
        }
    }

    let e = b.req("no.such.op", json!({})).await.unwrap_err();
    assert_eq!(code(&e), "BAD_REQUEST");
    let e = b.req("message.send", json!({ "channel_id": "eins" })).await.unwrap_err();
    assert_eq!(code(&e), "BAD_REQUEST");
    let e = b.req("message.send", json!({ "channel_id": general, "content": "x".repeat(4001) })).await.unwrap_err();
    assert_eq!(code(&e), "VALIDATION");
    let e = b.req("message.send", json!({ "channel_id": general, "content": "\u{1b}[2J böse" })).await.unwrap_err();
    assert_eq!(code(&e), "VALIDATION");
    let e = b.req("message.send", json!({ "channel_id": general, "content": "   " })).await.unwrap_err();
    assert_eq!(code(&e), "VALIDATION");
    let e = b.req("message.send", json!({ "channel_id": 999_999, "content": "x" })).await.unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    let e = b.req("message.send", json!({ "channel_id": general, "content": "x", "attachments": ["0123456789abcdef0123456789abcdef"] })).await.unwrap_err();
    assert_eq!(code(&e), "VALIDATION", "foreign/unknown attachment ids");
    let s = b.req("message.search", json!({ "query": "\"') OR 1=1; DROP TABLE messages; --" })).await.unwrap();
    assert!(s["messages"].as_array().unwrap().is_empty());
    let (s, _) = register(&ep, "../../admin", Some("X")).await;
    assert_eq!(s, 400);

    // A frame above the size limit closes only this connection; the server keeps running.
    let _ = b.ws.send(WsMessage::Text("x".repeat(300_000).into())).await;
    assert!(b.frame(Duration::from_secs(5)).await.is_none());
    let (mut c, _) = Client::connect(&ep, &member).await;
    c.req("ping", json!({})).await.unwrap();
    ts.stop().await;
}

#[tokio::test]
async fn excessive_requests_are_rate_limited() {
    let (ts, ep, _owner, member) = setup("rate").await;
    let mut limited = false;
    for _ in 0..15 {
        let (s, e) = login(&ep, "member", "falsch-falsch").await;
        if s == 429 {
            assert_eq!(code(&e["error"]), "RATE_LIMITED");
            limited = true;
            break;
        }
    }
    assert!(limited, "login attempts must be limited per IP");

    let (mut b, ready) = Client::connect(&ep, &member).await;
    let general = channel_id(&ready, "allgemein");
    let mut msg_limited = false;
    for i in 0..30 {
        if let Err(e) = b.req("message.send", json!({ "channel_id": general, "content": format!("flood {i}") })).await {
            assert_eq!(code(&e), "RATE_LIMITED");
            msg_limited = true;
            break;
        }
    }
    assert!(msg_limited, "message flood must be limited");
    ts.stop().await;
}

#[tokio::test]
async fn file_upload_download_and_limits() {
    let (ts, ep, owner, member) = setup("files").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let general = channel_id(&ready, "allgemein");

    let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[0u8; 100]].concat();
    let r = ep
        .upload(&format!("/api/v1/files?channel_id={general}&filename=..%2F..%2Fwindows%2Fevil.png"), &owner, png.clone(), |_, _| {})
        .await
        .unwrap();
    assert_eq!(r.status, 200, "{}", String::from_utf8_lossy(&r.body));
    let up: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(up["filename"], "evil.png", "path components stripped");
    assert_eq!(up["mime"], "image/png");
    let fid = up["id"].as_str().unwrap().to_string();

    // Unbound uploads are private to the uploader.
    let r = ep.request("GET", &format!("/api/v1/files/{fid}"), Some(&member), None, None).await.unwrap();
    assert_eq!(r.status, 404);
    let msg = a.req("message.send", json!({ "channel_id": general, "content": "", "attachments": [fid] })).await.unwrap();
    assert_eq!(msg["attachments"][0]["size"], png.len());
    let r = ep.request("GET", &format!("/api/v1/files/{fid}"), Some(&member), None, None).await.unwrap();
    assert_eq!(r.status, 200);
    assert_eq!(r.body, png);
    let r = ep.request("GET", &format!("/api/v1/files/{fid}"), None, None, None).await.unwrap();
    assert_eq!(r.status, 401, "downloads require a session");
    let r = ep.request("GET", "/api/v1/files/..%2F..%2Fnexus.db", Some(&owner), None, None).await.unwrap();
    assert_eq!(r.status, 404);

    // Executable content is never served as something a browser would run.
    let r = ep
        .upload(&format!("/api/v1/files?channel_id={general}&filename=x.html"), &owner, b"<script>alert(1)</script>".to_vec(), |_, _| {})
        .await
        .unwrap();
    let up: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(up["mime"], "application/octet-stream");

    // Size limit. The server answers 413 before reading the body and may close
    // the connection while the client is still sending, so a reset is accepted
    // too; what matters is that nothing gets stored.
    a.req("server.update", json!({ "max_upload_mb": 1 })).await.unwrap();
    let before = a.req("server.stats", json!({})).await.unwrap()["uploads_bytes"].clone();
    match ep.upload(&format!("/api/v1/files?channel_id={general}&filename=big.bin"), &owner, vec![7u8; 1_100_000], |_, _| {}).await {
        Ok(r) => assert_eq!(r.status, 413),
        Err(NetError::Connect(_)) => {}
        Err(e) => panic!("unexpected {e}"),
    }
    assert_eq!(a.req("server.stats", json!({})).await.unwrap()["uploads_bytes"], before);
    let leftovers = std::fs::read_dir(ts.dir.join("uploads")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with("tmp-")).count();
    assert_eq!(leftovers, 0, "partial upload removed");

    // Uploads can be disabled by the operator.
    a.req("server.update", json!({ "uploads_enabled": false })).await.unwrap();
    let r = ep.upload(&format!("/api/v1/files?channel_id={general}&filename=a.txt"), &owner, b"x".to_vec(), |_, _| {}).await.unwrap();
    assert_eq!(r.status, 403);
    ts.stop().await;
}

#[tokio::test]
async fn voice_channel_signaling_between_clients() {
    let (ts, ep, owner, member) = setup("voice").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let voice = channel_id(&ready_a, "Allgemein");
    let (ida, idb) = (ready_a["me"]["id"].as_i64().unwrap(), ready_b["me"]["id"].as_i64().unwrap());
    assert!(ready_a["ice"].is_object());

    let j = a.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    assert_eq!(j["participants"].as_array().unwrap().len(), 1);
    let ev = b.event("voice.state").await;
    assert_eq!((ev["user_id"].as_i64(), ev["left"].as_bool()), (Some(ida), Some(false)));

    // Signaling is only relayed between participants of the same channel.
    let e = b.req("rtc.signal", json!({ "to": ida, "data": { "sdp": "x" } })).await.unwrap_err();
    assert_eq!(code(&e), "NOT_FOUND");
    let j = b.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    assert_eq!(j["participants"].as_array().unwrap().len(), 2);
    b.req("rtc.signal", json!({ "to": ida, "data": { "type": "offer", "sdp": "v=0" } })).await.unwrap();
    let sig = a.event("rtc.signal").await;
    assert_eq!(sig["from"], idb);
    assert_eq!(sig["data"]["type"], "offer");

    // State changes are broadcast; screen sharing needs permission (members have it).
    b.req("voice.update", json!({ "muted": true, "screen": true })).await.unwrap();
    loop {
        let ev = a.event("voice.state").await;
        if ev["user_id"] == idb && ev["screen"] == true {
            assert_eq!(ev["muted"], true);
            break;
        }
    }
    // Text channels cannot be joined.
    let general = channel_id(&ready_a, "allgemein");
    assert_eq!(code(&a.req("voice.join", json!({ "channel_id": general })).await.unwrap_err()), "VALIDATION");

    b.req("voice.leave", json!({})).await.unwrap();
    loop {
        let ev = a.event("voice.state").await;
        if ev["user_id"] == idb && ev["left"] == true {
            break;
        }
    }
    ts.stop().await;
}

#[tokio::test]
async fn guests_cannot_share_screen() {
    let (ts, ep, owner, _) = setup("guest").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let guest_role = ready["guild"]["roles"].as_array().unwrap().iter().find(|r| r["name"] == "Gast").unwrap()["id"].clone();
    let inv = a.req("invite.create", json!({ "role_id": guest_role })).await.unwrap();
    let (_, g) = register(&ep, "gast", Some(inv["code"].as_str().unwrap())).await;
    let (mut gc, gready) = Client::connect(&ep, g["token"].as_str().unwrap()).await;
    let voice = channel_id(&gready, "Allgemein");
    gc.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    assert_eq!(code(&gc.req("voice.update", json!({ "screen": true })).await.unwrap_err()), "PERMISSION_DENIED");
    let general = channel_id(&gready, "allgemein");
    let r = ep
        .upload(&format!("/api/v1/files?channel_id={general}&filename=a.txt"), g["token"].as_str().unwrap(), b"x".to_vec(), |_, _| {})
        .await
        .unwrap();
    assert_eq!(r.status, 403, "guests cannot attach files");
    ts.stop().await;
}

#[tokio::test]
async fn direct_messages_and_blocking() {
    let (ts, ep, owner, member) = setup("dm").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let (ida, idb) = (ready_a["me"]["id"].as_i64().unwrap(), ready_b["me"]["id"].as_i64().unwrap());
    let dm = a.req("dm.open", json!({ "user_id": idb })).await.unwrap();
    let cid = dm["channel_id"].as_i64().unwrap();
    assert_eq!(b.event("dm.created").await["user_id"], ida);
    a.req("message.send", json!({ "channel_id": cid, "content": "privat" })).await.unwrap();
    assert_eq!(b.event("message.created").await["message"]["content"], "privat");

    // A third user cannot read the DM.
    let inv = a.req("invite.create", json!({})).await.unwrap();
    let (_, c) = register(&ep, "dritter", Some(inv["code"].as_str().unwrap())).await;
    let (mut cc, _) = Client::connect(&ep, c["token"].as_str().unwrap()).await;
    assert_eq!(code(&cc.req("message.history", json!({ "channel_id": cid })).await.unwrap_err()), "NOT_FOUND");

    // Friends: request + accept.
    a.req("relationship.request", json!({ "user_id": idb })).await.unwrap();
    assert_eq!(b.event("relationship.update").await["kind"], "incoming");
    let r = b.req("relationship.request", json!({ "user_id": ida })).await.unwrap();
    assert_eq!(r["kind"], "friend");

    // Blocking stops DMs in both directions.
    b.req("relationship.block", json!({ "user_id": ida })).await.unwrap();
    assert_eq!(code(&a.req("message.send", json!({ "channel_id": cid, "content": "hallo?" })).await.unwrap_err()), "BLOCKED");
    assert_eq!(code(&b.req("message.send", json!({ "channel_id": cid, "content": "x" })).await.unwrap_err()), "BLOCKED");
    b.req("relationship.unblock", json!({ "user_id": ida })).await.unwrap();
    a.req("message.send", json!({ "channel_id": cid, "content": "wieder da" })).await.unwrap();
    ts.stop().await;
}

#[tokio::test]
async fn backup_and_restore() {
    let (mut ts, ep, owner, _) = setup("backup").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let general = channel_id(&ready, "allgemein");
    a.req("message.send", json!({ "channel_id": general, "content": "vor der Sicherung" })).await.unwrap();
    let b = a.req("backup.create", json!({})).await.unwrap();
    let name = b["name"].as_str().unwrap().to_string();
    a.req("message.send", json!({ "channel_id": general, "content": "nach der Sicherung" })).await.unwrap();
    assert_eq!(a.req("backup.list", json!({})).await.unwrap()[0]["name"], name);
    assert_eq!(code(&a.req("backup.restore", json!({ "name": "../nexus.db" })).await.unwrap_err()), "VALIDATION");
    a.req("backup.restore", json!({ "name": name })).await.unwrap();
    // The handle reports the restart request; emulate the supervisor loop.
    tokio::time::timeout(Duration::from_secs(5), ts.srv().restart_requested()).await.unwrap();
    ts.restart().await;
    let ep = ts.endpoint();
    let (mut a, _) = Client::connect(&ep, &owner).await;
    let h = a.req("message.history", json!({ "channel_id": general })).await.unwrap();
    let texts: Vec<&str> = h["messages"].as_array().unwrap().iter().map(|m| m["content"].as_str().unwrap()).collect();
    assert_eq!(texts, vec!["vor der Sicherung"]);
    assert!(std::fs::read_dir(&ts.dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with("nexus.db.before-restore")));
    ts.stop().await;
}

#[tokio::test]
async fn tls_certificate_pinning() {
    let ts = TestServer::start("tls", true).await;
    let fp = ts.srv().tls_fingerprint.clone().unwrap();
    assert_eq!(fp.len(), 64);

    // Unknown self-signed certificate: rejected, fingerprint reported for confirmation.
    let ep = Endpoint::new(&ts.address(), None).unwrap();
    match ep.request("GET", "/api/v1/info", None, None, None).await {
        Err(NetError::Untrusted { fingerprint }) => assert_eq!(fingerprint, fp),
        other => panic!("expected Untrusted, got {:?}", other.map(|r| r.status)),
    }
    match ep.connect_ws().await {
        Err(NetError::Untrusted { fingerprint }) => assert_eq!(fingerprint, fp),
        other => panic!("expected Untrusted for WebSocket, got {:?}", other.is_ok()),
    }
    // Wrong pin: mismatch is detected (possible man-in-the-middle).
    let ep = Endpoint::new(&ts.address(), Some(&"AB".repeat(32))).unwrap();
    assert!(matches!(ep.request("GET", "/api/v1/info", None, None, None).await, Err(NetError::Mismatch { .. })));
    // Correct pin: works for HTTP and WebSocket.
    let ep = Endpoint::new(&ts.address(), Some(&fp)).unwrap();
    assert_eq!(ep.request("GET", "/api/v1/info", None, None, None).await.unwrap().status, 200);
    let setup = ts.srv().setup_code.clone().unwrap();
    let (s, r) = register(&ep, "owner", Some(&setup)).await;
    assert_eq!(s, 200);
    let (mut c, ready) = Client::connect(&ep, r["token"].as_str().unwrap()).await;
    assert_eq!(ready["me"]["username"], "owner");
    c.req("ping", json!({})).await.unwrap();
    // The certificate is persisted: same fingerprint after restart.
    let mut ts = ts;
    ts.restart().await;
    assert_eq!(ts.srv().tls_fingerprint.as_deref(), Some(fp.as_str()));
    ts.stop().await;
}

#[tokio::test]
async fn server_stats_and_logs_for_admins() {
    let (ts, ep, owner, _) = setup("stats").await;
    let (mut a, _) = Client::connect(&ep, &owner).await;
    let s = a.req("server.stats", json!({})).await.unwrap();
    assert!(s["connections"].as_u64().unwrap() >= 1);
    assert!(s["memory_bytes"].as_u64().unwrap_or(1) > 0);
    let settings = a.req("server.settings", json!({})).await.unwrap();
    assert_eq!(settings["config"]["exposed"], false);
    a.req("server.logs", json!({ "limit": 10 })).await.unwrap();
    ts.stop().await;
}

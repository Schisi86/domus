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

#[tokio::test]
async fn reactions_and_pins() {
    let (ts, ep, owner, member) = setup("react").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let general = channel_id(&ready, "allgemein");
    let idb = ready_b["me"]["id"].as_i64().unwrap();
    let m = a.req("message.send", json!({ "channel_id": general, "content": "Abstimmung?" })).await.unwrap();
    let mid = m["id"].clone();

    b.req("reaction.add", json!({ "message_id": mid, "emoji": "👍" })).await.unwrap();
    let ev = a.event("reaction.update").await;
    assert_eq!((ev["emoji"].as_str(), ev["user_id"].as_i64(), ev["added"].as_bool()), (Some("👍"), Some(idb), Some(true)));
    let again = b.req("reaction.add", json!({ "message_id": mid, "emoji": "👍" })).await.unwrap();
    assert_eq!(again["changed"], false, "idempotent");
    assert_eq!(code(&b.req("reaction.add", json!({ "message_id": mid, "emoji": "haha" })).await.unwrap_err()), "VALIDATION");
    let h = a.req("message.history", json!({ "channel_id": general })).await.unwrap();
    assert_eq!(h["messages"][0]["reactions"][0]["users"], json!([idb]));
    b.req("reaction.remove", json!({ "message_id": mid, "emoji": "👍" })).await.unwrap();
    let h = a.req("message.history", json!({ "channel_id": general })).await.unwrap();
    assert!(h["messages"][0]["reactions"].as_array().unwrap().is_empty());

    // Pinning is a moderation right in server channels.
    assert_eq!(code(&b.req("message.pin", json!({ "message_id": mid, "pinned": true })).await.unwrap_err()), "PERMISSION_DENIED");
    let p = a.req("message.pin", json!({ "message_id": mid, "pinned": true })).await.unwrap();
    assert!(p["pinned_at"].is_i64());
    let pins = b.req("message.pins", json!({ "channel_id": general })).await.unwrap();
    assert_eq!(pins["messages"].as_array().unwrap().len(), 1);
    a.req("message.pin", json!({ "message_id": mid, "pinned": false })).await.unwrap();
    let pins = b.req("message.pins", json!({ "channel_id": general })).await.unwrap();
    assert!(pins["messages"].as_array().unwrap().is_empty());
    ts.stop().await;
}

/// Registers one more member with a fresh invite and returns (token, user id).
async fn extra_member(ep: &Endpoint, admin: &mut Client, name: &str) -> (String, i64) {
    let inv = admin.req("invite.create", json!({ "max_uses": 1 })).await.unwrap();
    let (s, r) = register(ep, name, inv["code"].as_str()).await;
    assert_eq!(s, 200, "{r}");
    let token = r["token"].as_str().unwrap().to_string();
    let (_, ready) = Client::connect(ep, &token).await;
    (token, ready["me"]["id"].as_i64().unwrap())
}

#[tokio::test]
async fn timeout_kick_and_voice_moderation() {
    let (ts, ep, owner, member) = setup("moderation").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let (ida, idb) = (ready_a["me"]["id"].as_i64().unwrap(), ready_b["me"]["id"].as_i64().unwrap());
    let general = channel_id(&ready_a, "allgemein");
    let voice = channel_id(&ready_a, "Allgemein");

    // Timeout: no writing or reacting, visible to everyone, lifted again.
    let t = a.req("member.timeout", json!({ "user_id": idb, "minutes": 10, "reason": "Spam" })).await.unwrap();
    assert!(t["timeout_until"].as_i64().unwrap() > 0);
    loop {
        let ev = a.event("member.updated").await;
        if ev["id"] == idb {
            assert!(ev["timeout_until"].as_i64().is_some());
            break;
        }
    }
    let e = b.req("message.send", json!({ "channel_id": general, "content": "darf ich?" })).await.unwrap_err();
    assert_eq!(code(&e), "PERMISSION_DENIED");
    let m = a.req("message.send", json!({ "channel_id": general, "content": "Regeln lesen" })).await.unwrap();
    assert_eq!(code(&b.req("reaction.add", json!({ "message_id": m["id"], "emoji": "👍" })).await.unwrap_err()), "PERMISSION_DENIED");
    assert_eq!(code(&b.req("member.timeout", json!({ "user_id": ida, "minutes": 5 })).await.unwrap_err()), "PERMISSION_DENIED");
    // Joining voice works, but only listening.
    let j = b.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    assert_eq!((j["self"]["suppressed"].as_bool(), j["self"]["muted"].as_bool()), (Some(true), Some(true)));
    a.req("member.timeout", json!({ "user_id": idb, "minutes": 0 })).await.unwrap();
    b.req("message.send", json!({ "channel_id": general, "content": "danke" })).await.unwrap();
    let st = b.req("voice.update", json!({ "muted": false })).await.unwrap();
    assert_eq!((st["suppressed"].as_bool(), st["muted"].as_bool()), (Some(false), Some(false)), "speaking allowed again");
    assert_eq!(code(&a.req("member.timeout", json!({ "user_id": idb, "minutes": 99999 })).await.unwrap_err()), "VALIDATION");

    // Server mute / deafen: the member cannot lift it.
    a.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    let m = a.req("voice.moderate", json!({ "user_id": idb, "mute": true, "deafen": true })).await.unwrap();
    assert_eq!((m["server_muted"].as_bool(), m["server_deafened"].as_bool()), (Some(true), Some(true)));
    let st = b.req("voice.update", json!({ "muted": false, "deafened": false })).await.unwrap();
    assert_eq!((st["muted"].as_bool(), st["deafened"].as_bool()), (Some(true), Some(true)));
    assert_eq!(code(&b.req("voice.moderate", json!({ "user_id": ida, "mute": true })).await.unwrap_err()), "PERMISSION_DENIED");
    assert_eq!(code(&b.req("voice.sound", json!({ "sound": "airhorn" })).await.unwrap_err()), "PERMISSION_DENIED", "no sounds while muted");
    a.req("voice.moderate", json!({ "user_id": idb, "mute": false, "deafen": false })).await.unwrap();
    let st = b.req("voice.update", json!({ "muted": false, "deafened": false })).await.unwrap();
    assert_eq!((st["muted"].as_bool(), st["deafened"].as_bool()), (Some(false), Some(false)));

    // Soundboard: everyone in the channel hears it, with a short cooldown.
    b.req("voice.sound", json!({ "sound": "airhorn" })).await.unwrap();
    let ev = a.event("voice.sound").await;
    assert_eq!((ev["user_id"].as_i64(), ev["sound"].as_str()), (Some(idb), Some("airhorn")));
    assert_eq!(code(&b.req("voice.sound", json!({ "sound": "tada" })).await.unwrap_err()), "RATE_LIMITED");
    assert_eq!(code(&a.req("voice.sound", json!({ "sound": "Bad Name" })).await.unwrap_err()), "VALIDATION");

    // Move to another channel; then a user limit keeps others out.
    let lounge = a.req("channel.create", json!({ "kind": "voice", "name": "Lounge" })).await.unwrap()["id"].as_i64().unwrap();
    a.req("voice.move", json!({ "user_id": idb, "channel_id": lounge })).await.unwrap();
    let mv = b.event("voice.moved").await;
    assert_eq!(mv["channel_id"].as_i64(), Some(lounge));
    b.req("voice.join", json!({ "channel_id": lounge })).await.unwrap();
    a.req("channel.update", json!({ "channel_id": lounge, "user_limit": 1 })).await.unwrap();
    let (third, _) = extra_member(&ep, &mut a, "dritter").await;
    let (mut c, _) = Client::connect(&ep, &third).await;
    assert_eq!(code(&c.req("voice.join", json!({ "channel_id": lounge })).await.unwrap_err()), "VOICE_FULL");
    a.req("voice.join", json!({ "channel_id": lounge })).await.expect("moderators may exceed the limit");
    assert_eq!(code(&a.req("channel.update", json!({ "channel_id": lounge, "user_limit": 500 })).await.unwrap_err()), "VALIDATION");
    // Disconnect.
    a.req("voice.move", json!({ "user_id": idb, "channel_id": null })).await.unwrap();
    let mv = b.event("voice.moved").await;
    assert!(mv["channel_id"].is_null());

    // Kick: signed out, must be approved again.
    a.req("member.kick", json!({ "user_id": idb, "reason": "Test" })).await.unwrap();
    let mut closed = false;
    for _ in 0..10 {
        if b.frame(Duration::from_secs(2)).await.is_none() {
            closed = true;
            break;
        }
    }
    assert!(closed, "kicked client is disconnected");
    let (s, e) = login(&ep, "member", "geheim123").await;
    assert_eq!((s, code(&e["error"])), (403, "ACCOUNT_PENDING"));
    a.req("member.approve", json!({ "user_id": idb })).await.unwrap();
    assert_eq!(login(&ep, "member", "geheim123").await.0, 200);
    let _ = c.req("ping", json!({})).await;
    ts.stop().await;
}

#[tokio::test]
async fn polls_forwarding_slowmode_and_mark_unread() {
    let (ts, ep, owner, member) = setup("polls").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let idb = ready_b["me"]["id"].as_i64().unwrap();
    let general = channel_id(&ready_a, "allgemein");

    // Polls
    let e = a.req("poll.create", json!({ "channel_id": general, "question": "Wann?", "options": ["Heute"] })).await.unwrap_err();
    assert_eq!(code(&e), "VALIDATION");
    let p = a.req("poll.create", json!({ "channel_id": general, "question": "Wann spielen wir?", "options": ["Freitag", "Samstag", ""], "hours": 24 })).await.unwrap();
    let pid = p["id"].as_i64().unwrap();
    assert_eq!(p["poll"]["options"].as_array().unwrap().len(), 2, "empty answers are dropped");
    let ev = b.event("message.created").await;
    assert_eq!(ev["message"]["poll"]["question"], "Wann spielen wir?");
    let v = b.req("poll.vote", json!({ "message_id": pid, "options": [1] })).await.unwrap();
    assert_eq!(v["poll"]["options"][1]["voters"], json!([idb]));
    loop {
        let ev = a.event("message.updated").await;
        if ev["id"] == pid {
            assert_eq!(ev["poll"]["options"][1]["voters"], json!([idb]));
            break;
        }
    }
    assert_eq!(code(&b.req("poll.vote", json!({ "message_id": pid, "options": [0, 1] })).await.unwrap_err()), "VALIDATION", "single choice");
    let v = b.req("poll.vote", json!({ "message_id": pid, "options": [0] })).await.unwrap();
    assert_eq!((v["poll"]["options"][0]["voters"].clone(), v["poll"]["options"][1]["voters"].clone()), (json!([idb]), json!([])), "vote changed");
    assert_eq!(code(&b.req("poll.end", json!({ "message_id": pid })).await.unwrap_err()), "PERMISSION_DENIED");
    a.req("poll.end", json!({ "message_id": pid })).await.unwrap();
    assert_eq!(code(&b.req("poll.vote", json!({ "message_id": pid, "options": [1] })).await.unwrap_err()), "VALIDATION", "ended");

    // Forwarding with a file: new copy, original author noted.
    let other = a.req("channel.create", json!({ "kind": "text", "name": "Zweiter" })).await.unwrap()["id"].as_i64().unwrap();
    let r = ep.upload(&format!("/api/v1/files?channel_id={general}&filename=notiz.txt"), &member, b"hallo datei".to_vec(), |_, _| {}).await.unwrap();
    let fid = serde_json::from_slice::<Value>(&r.body).unwrap()["id"].as_str().unwrap().to_string();
    let orig = b.req("message.send", json!({ "channel_id": general, "content": "Schau mal", "attachments": [fid] })).await.unwrap();
    let fw = a.req("message.forward", json!({ "message_id": orig["id"], "channel_id": other })).await.unwrap();
    assert_eq!((fw["forwarded_from"].as_i64(), fw["content"].as_str(), fw["channel_id"].as_i64()), (Some(idb), Some("Schau mal"), Some(other)));
    let new_fid = fw["attachments"][0]["id"].as_str().unwrap();
    assert_ne!(new_fid, fid);
    let dl = ep.request("GET", &format!("/api/v1/files/{new_fid}"), Some(&member), None, None).await.unwrap();
    assert_eq!((dl.status, dl.body.as_slice()), (200, b"hallo datei".as_slice()));
    assert_eq!(code(&a.req("message.forward", json!({ "message_id": pid, "channel_id": other })).await.unwrap_err()), "VALIDATION", "no polls");

    // Slow mode for members; moderators are exempt.
    a.req("channel.update", json!({ "channel_id": general, "slowmode": 30 })).await.unwrap();
    b.req("message.send", json!({ "channel_id": general, "content": "eins" })).await.unwrap();
    let e = b.req("message.send", json!({ "channel_id": general, "content": "zwei" })).await.unwrap_err();
    assert_eq!(code(&e), "RATE_LIMITED");
    assert!(e["msg"].as_str().unwrap().contains("Slow-Mode"));
    a.req("message.send", json!({ "channel_id": general, "content": "eins" })).await.unwrap();
    a.req("message.send", json!({ "channel_id": general, "content": "zwei" })).await.unwrap();

    // Mark as unread moves the read marker back.
    let last = a.req("message.send", json!({ "channel_id": general, "content": "neu" })).await.unwrap()["id"].as_i64().unwrap();
    b.req("channel.ack", json!({ "channel_id": general, "message_id": last })).await.unwrap();
    b.req("channel.ack", json!({ "channel_id": general, "message_id": pid - 1, "unread": true })).await.unwrap();
    let (_, again) = Client::connect(&ep, &member).await;
    assert_eq!(again["read_states"][general.to_string()].as_i64(), Some(pid - 1));
    ts.stop().await;
}

#[tokio::test]
async fn profiles_call_reactions_inbox_and_voice_messages() {
    let (ts, ep, owner, member) = setup("premium").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let (ida, idb) = (ready_a["me"]["id"].as_i64().unwrap(), ready_b["me"]["id"].as_i64().unwrap());
    let general = channel_id(&ready_a, "allgemein");
    let voice = channel_id(&ready_a, "Allgemein");

    // Profile: bio and banner colors, visible to others.
    b.req("user.update", json!({ "bio": "Spielt gern Strategie 🎲", "banner": "#FF00AA,#00ccff" })).await.unwrap();
    loop {
        let ev = a.event("member.updated").await;
        if ev["id"] == idb {
            assert_eq!((ev["bio"].as_str(), ev["banner"].as_str()), (Some("Spielt gern Strategie 🎲"), Some("#ff00aa,#00ccff")));
            break;
        }
    }
    assert_eq!(code(&b.req("user.update", json!({ "banner": "red; background:url(x)" })).await.unwrap_err()), "VALIDATION");
    assert_eq!(code(&b.req("user.update", json!({ "bio": "x".repeat(300) })).await.unwrap_err()), "VALIDATION");

    // Inbox: mentions of me, newest first.
    a.req("message.send", json!({ "channel_id": general, "content": "Hallo @member, schau mal" })).await.unwrap();
    a.req("message.send", json!({ "channel_id": general, "content": "ohne Erwähnung" })).await.unwrap();
    let last = a.req("message.send", json!({ "channel_id": general, "content": "@member nochmal" })).await.unwrap();
    let inbox = b.req("mention.list", json!({})).await.unwrap();
    let list = inbox["messages"].as_array().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0]["id"], last["id"]);

    // Call: raise hand and floating reactions.
    a.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    b.req("voice.join", json!({ "channel_id": voice })).await.unwrap();
    let st = b.req("voice.update", json!({ "hand": true })).await.unwrap();
    assert!(st["hand"].as_i64().is_some());
    let raised_at = st["hand"].as_i64();
    let st = b.req("voice.update", json!({ "hand": true })).await.unwrap();
    assert_eq!(st["hand"].as_i64(), raised_at, "raising again keeps the queue position");
    let st = b.req("voice.update", json!({ "hand": false })).await.unwrap();
    assert!(st["hand"].is_null());
    b.req("voice.react", json!({ "emoji": "🎉" })).await.unwrap();
    let ev = a.event("voice.reaction").await;
    assert_eq!((ev["user_id"].as_i64(), ev["emoji"].as_str()), (Some(idb), Some("🎉")));
    assert_eq!(code(&b.req("voice.react", json!({ "emoji": "👍" })).await.unwrap_err()), "RATE_LIMITED");
    assert_eq!(code(&a.req("voice.react", json!({ "emoji": "hallo" })).await.unwrap_err()), "VALIDATION");
    let _ = ida;

    // Voice message: an audio/webm upload is recognized as audio.
    let mut weba = b"\x1a\x45\xdf\xa3".to_vec();
    weba.extend_from_slice(&[0u8; 200]);
    let r = ep.upload(&format!("/api/v1/files?channel_id={general}&filename=sprachnachricht.weba"), &member, weba, |_, _| {}).await.unwrap();
    let up: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(up["mime"], "audio/webm");
    let r = ep.upload(&format!("/api/v1/files?channel_id={general}&filename=video.webm"), &member, b"\x1a\x45\xdf\xa3rest".to_vec(), |_, _| {}).await.unwrap();
    let up: Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(up["mime"], "application/octet-stream", "only voice-message files count as audio");
    ts.stop().await;
}

#[tokio::test]
async fn self_dm_notes_to_self() {
    let (ts, ep, owner, _member) = setup("selfdm").await;
    let (mut a, ready) = Client::connect(&ep, &owner).await;
    let me = ready["me"]["id"].as_i64().unwrap();
    // Opening a DM with myself creates a one-member notes channel.
    let dm = a.req("dm.open", json!({ "user_id": me })).await.unwrap();
    let cid = dm["channel_id"].as_i64().unwrap();
    assert_eq!(dm["user_id"].as_i64(), Some(me));
    a.req("message.send", json!({ "channel_id": cid, "content": "Nicht vergessen: Milch kaufen" })).await.unwrap();
    // Opening again returns the same channel (not a new one).
    let again = a.req("dm.open", json!({ "user_id": me })).await.unwrap();
    assert_eq!(again["channel_id"].as_i64(), Some(cid));
    // A fresh session lists the self-DM and can read the note back.
    let (mut b, ready2) = Client::connect(&ep, &owner).await;
    let listed = ready2["dms"].as_array().unwrap().iter().any(|d| d["channel_id"].as_i64() == Some(cid) && d["user_id"].as_i64() == Some(me));
    assert!(listed, "self-DM is listed: {}", ready2["dms"]);
    let hist = b.req("message.history", json!({ "channel_id": cid })).await.unwrap();
    assert_eq!(hist["messages"][0]["content"], "Nicht vergessen: Milch kaufen");
    ts.stop().await;
}

#[tokio::test]
async fn e2e_key_directory_and_direct_signaling() {
    let (ts, ep, owner, member) = setup("e2e").await;
    let (mut a, ready_a) = Client::connect(&ep, &owner).await;
    let (mut b, ready_b) = Client::connect(&ep, &member).await;
    let (ida, idb) = (ready_a["me"]["id"].as_i64().unwrap(), ready_b["me"]["id"].as_i64().unwrap());

    // Public keys: published once, announced to everyone, listed newest first.
    let key = "BHq1v0mB7vJm1mXq9T0J1Jw3w2aYt8mX2n8pQJ0mQF8kq4h6ZrM0n3c1v5b7x9z1A3C5E7G9I1K3M5O7Q9S1U3W5Y7a";
    let r = a.req("e2e.publish", json!({ "kid": "00112233aabbccdd", "key": key })).await.unwrap();
    assert_eq!(r["added"], true);
    assert_eq!(b.event("e2e.key").await["user_id"], ida);
    assert_eq!(a.req("e2e.publish", json!({ "kid": "00112233aabbccdd", "key": key })).await.unwrap()["added"], false);
    a.req("e2e.publish", json!({ "kid": "ffeeddccbbaa0099", "key": key })).await.unwrap();
    let keys = b.req("e2e.keys", json!({ "user_ids": [ida, idb] })).await.unwrap();
    let list = keys["keys"].as_array().unwrap();
    assert_eq!(list.len(), 2, "only alice has keys: {keys}");
    assert!(list.iter().all(|k| k["user_id"] == ida && k["key"] == key));
    // Malformed keys and ids are refused.
    for (kid, k) in [("short", key), ("00112233AABBCCDD", key), ("00112233aabbccdd", "zu kurz"), ("00112233aabbccdd", "<script>alert(1)</script>....................................................................")] {
        assert_eq!(code(&a.req("e2e.publish", json!({ "kid": kid, "key": k })).await.unwrap_err()), "VALIDATION");
    }
    assert_eq!(code(&a.req("e2e.keys", json!({ "user_ids": [] })).await.unwrap_err()), "VALIDATION");

    // The server stores an encrypted DM as it is, and hands the whole envelope
    // back in a reply preview (a cut-off envelope could not be decrypted).
    let dm = a.req("dm.open", json!({ "user_id": idb })).await.unwrap();
    let cid = dm["channel_id"].as_i64().unwrap();
    let envelope = format!("nxe1.00112233aabbccdd.ffeeddccbbaa0099.AAAAAAAAAAAAAAAA.{}", "Qk".repeat(150));
    let first = a.req("message.send", json!({ "channel_id": cid, "content": envelope })).await.unwrap();
    assert_eq!(first["content"], envelope);
    let reply = b.req("message.send", json!({ "channel_id": cid, "content": "ok", "reply_to": first["id"] })).await.unwrap();
    assert_eq!(reply["reply_preview"]["content"], envelope);
    let plain = a.req("message.send", json!({ "channel_id": cid, "content": "x".repeat(400) })).await.unwrap();
    let reply2 = b.req("message.send", json!({ "channel_id": cid, "content": "ok", "reply_to": plain["id"] })).await.unwrap();
    assert_eq!(reply2["reply_preview"]["content"].as_str().unwrap().len(), 160);

    // Direct transfer handshake: relayed to the other user, not stored.
    a.req("p2p.signal", json!({ "to": idb, "data": { "x": "t1", "k": "offer", "name": "film.mkv", "size": 5_000_000_000u64 } })).await.unwrap();
    let sig = b.event("p2p.signal").await;
    assert_eq!(sig["from"], ida);
    assert_eq!(sig["data"]["size"], 5_000_000_000u64);
    // Oversized payloads, unknown and blocked users are refused.
    let big = "y".repeat(70_000);
    assert_eq!(code(&a.req("p2p.signal", json!({ "to": idb, "data": { "sdp": big } })).await.unwrap_err()), "VALIDATION");
    assert_eq!(code(&a.req("p2p.signal", json!({ "to": 9999, "data": {} })).await.unwrap_err()), "NOT_FOUND");
    b.req("relationship.block", json!({ "user_id": ida })).await.unwrap();
    assert_eq!(code(&a.req("p2p.signal", json!({ "to": idb, "data": {} })).await.unwrap_err()), "BLOCKED");
    b.req("relationship.unblock", json!({ "user_id": ida })).await.unwrap();
    // Offline: the sender is told instead of the offer vanishing.
    drop(b);
    let mut refused = false;
    for _ in 0..40 {
        if let Err(e) = a.req("p2p.signal", json!({ "to": idb, "data": {} })).await {
            assert_eq!(code(&e), "NOT_FOUND");
            refused = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(refused, "signal to an offline user must be refused");
    ts.stop().await;
}

#[tokio::test]
async fn link_device_with_one_time_code_and_sign_it_out() {
    let (ts, ep, owner, _member) = setup("link").await;
    let (mut pc, _) = Client::connect(&ep, &owner).await;

    // A code signs in a new device with its own session, once.
    let link = pc.req("device.link_create", json!({})).await.unwrap();
    let code_str = link["code"].as_str().unwrap().to_string();
    assert_eq!(code_str.len(), 20);
    assert!(link["expires_at"].as_i64().unwrap() > 0);
    let (s, phone) = post(&ep, "/api/v1/auth/link", json!({ "code": code_str, "device": "Pixel 9" })).await;
    assert_eq!(s, 200, "{phone}");
    assert_eq!(phone["user"]["username"], "owner");
    let phone_token = phone["token"].as_str().unwrap().to_string();
    assert_ne!(phone_token, owner, "a new session, not the token of the first device");
    assert_eq!(pc.event("device.linked").await["device"], "Pixel 9");
    let (s, e) = post(&ep, "/api/v1/auth/link", json!({ "code": code_str })).await;
    assert_eq!((s, code(&e["error"])), (401, "INVALID_CREDENTIALS"), "codes work only once");
    let (s, _) = post(&ep, "/api/v1/auth/link", json!({ "code": "x".repeat(200) })).await;
    assert_eq!(s, 401, "oversized codes are refused");

    // Both devices appear in the list; the own one is marked.
    let (mut ph, _) = Client::connect(&ep, &phone_token).await;
    let list = ph.req("device.list", json!({})).await.unwrap();
    let devs = list["devices"].as_array().unwrap();
    assert_eq!(devs.len(), 2, "{list}");
    let me = devs.iter().find(|d| d["current"] == true).unwrap();
    assert_eq!(me["device"], "Pixel 9");
    assert_eq!(me["id"].as_str().unwrap().len(), 16);
    assert!(!list.to_string().contains(&phone_token), "tokens are never listed");
    let pc_id = devs.iter().find(|d| d["current"] == false).unwrap()["id"].as_str().unwrap().to_string();

    // The own session cannot be revoked here; another one can, and only it is closed.
    assert_eq!(code(&ph.req("device.revoke", json!({ "id": me["id"] })).await.unwrap_err()), "VALIDATION");
    assert_eq!(code(&ph.req("device.revoke", json!({ "id": "0000000000000000" })).await.unwrap_err()), "NOT_FOUND");
    ph.req("device.revoke", json!({ "id": pc_id })).await.unwrap();
    let mut closed = false;
    for _ in 0..10 {
        if pc.frame(Duration::from_secs(3)).await.is_none() {
            closed = true;
            break;
        }
    }
    assert!(closed, "the revoked device is disconnected");
    assert_eq!(ph.req("device.list", json!({})).await.unwrap()["devices"].as_array().unwrap().len(), 1, "phone stays signed in");
    let mut ws = ep.connect_ws().await.unwrap();
    ws.send(WsMessage::Text(json!({ "id": 1, "op": "auth", "d": { "token": owner } }).to_string().into())).await.unwrap();
    let Some(Ok(WsMessage::Text(t))) = ws.next().await else { panic!("expected error frame") };
    assert!(t.as_str().contains("UNAUTHORIZED"), "revoked token no longer works");
    ts.stop().await;
}

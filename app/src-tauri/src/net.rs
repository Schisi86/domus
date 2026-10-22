//! Bridge between the web UI and `nexus-net`: HTTP, uploads/downloads and
//! WebSocket connections with TLS certificate pinning, executed in Rust.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use nexus_net::{Endpoint, NetError, WsMessage};
use serde::Serialize;
use tauri::ipc::{Channel, InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

#[derive(Default)]
pub struct NetState {
    endpoints: Mutex<HashMap<(String, String), Endpoint>>,
    sockets: Mutex<HashMap<String, mpsc::UnboundedSender<WsCmd>>>,
}

enum WsCmd {
    Send(String),
    Close,
}

/// Error shape understood by the UI (`src/net/transport.ts`).
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NetErr {
    Untrusted { fingerprint: String },
    Mismatch { expected: String, actual: String },
    BadUrl { message: String },
    Connect { message: String },
    Timeout,
    Status { status: u16 },
}

impl From<NetError> for NetErr {
    fn from(e: NetError) -> Self {
        match e {
            NetError::Untrusted { fingerprint } => NetErr::Untrusted { fingerprint },
            NetError::Mismatch { expected, actual } => NetErr::Mismatch { expected, actual },
            NetError::BadUrl(m) => NetErr::BadUrl { message: m },
            NetError::Connect(m) => NetErr::Connect { message: m },
            NetError::Timeout => NetErr::Timeout,
        }
    }
}

fn endpoint(state: &NetState, address: &str, fingerprint: Option<&str>) -> Result<Endpoint, NetErr> {
    let key = (address.to_string(), fingerprint.unwrap_or("").to_string());
    let mut map = state.endpoints.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(e) = map.get(&key) {
        return Ok(e.clone());
    }
    let e = Endpoint::new(address, fingerprint)?;
    if map.len() > 64 {
        map.clear();
    }
    map.insert(key, e.clone());
    Ok(e)
}

#[derive(Serialize)]
pub struct HttpOut {
    status: u16,
    body: String,
}

#[tauri::command]
pub async fn net_http(
    state: State<'_, NetState>,
    address: String,
    fingerprint: Option<String>,
    method: String,
    path: String,
    token: Option<String>,
    body: Option<String>,
) -> Result<HttpOut, NetErr> {
    let ep = endpoint(&state, &address, fingerprint.as_deref())?;
    let ct = body.as_ref().map(|_| "application/json");
    let r = ep.request(&method, &path, token.as_deref(), body.map(String::into_bytes), ct).await?;
    Ok(HttpOut { status: r.status, body: String::from_utf8_lossy(&r.body).into_owned() })
}

/// Binary GET (images, avatars). Returns raw bytes to avoid base64 overhead.
#[tauri::command]
pub async fn net_bytes(
    state: State<'_, NetState>,
    address: String,
    fingerprint: Option<String>,
    path: String,
    token: Option<String>,
) -> Result<Response, NetErr> {
    let ep = endpoint(&state, &address, fingerprint.as_deref())?;
    let r = ep.request("GET", &path, token.as_deref(), None, None).await?;
    if r.status != 200 {
        return Err(NetErr::Status { status: r.status });
    }
    Ok(Response::new(r.body))
}

#[derive(Clone, Serialize)]
struct Progress<'a> {
    id: &'a str,
    done: u64,
    total: Option<u64>,
}

/// Raw-body upload. Metadata travels in headers because the body is binary:
/// `x-address`, `x-fingerprint`, `x-path`, `x-token`, `x-upload-id`.
#[tauri::command]
pub async fn net_upload(app: AppHandle, state: State<'_, NetState>, request: Request<'_>) -> Result<HttpOut, NetErr> {
    let h = request.headers();
    let get = |k: &str| h.get(k).and_then(|v| v.to_str().ok()).map(String::from);
    let (Some(address), Some(path), Some(token)) = (get("x-address"), get("x-path"), get("x-token")) else {
        return Err(NetErr::BadUrl { message: "fehlende Upload-Parameter".into() });
    };
    let fingerprint = get("x-fingerprint").filter(|s| !s.is_empty());
    let upload_id = get("x-upload-id").unwrap_or_default();
    let InvokeBody::Raw(data) = request.body() else {
        return Err(NetErr::BadUrl { message: "Upload erwartet Binärdaten".into() });
    };
    let ep = endpoint(&state, &address, fingerprint.as_deref())?;
    let data = data.clone();
    let app2 = app.clone();
    let last = std::sync::Mutex::new(u64::MAX);
    let r = ep
        .upload(&path, &token, data, move |done, total| {
            // Throttle to whole percent steps.
            let pct = if total == 0 { 100 } else { done * 100 / total };
            let mut l = last.lock().unwrap_or_else(|p| p.into_inner());
            if pct != *l || done == total {
                *l = pct;
                let _ = app2.emit("net://progress", Progress { id: &upload_id, done, total: Some(total) });
            }
        })
        .await?;
    Ok(HttpOut { status: r.status, body: String::from_utf8_lossy(&r.body).into_owned() })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn net_download(
    app: AppHandle,
    state: State<'_, NetState>,
    address: String,
    fingerprint: Option<String>,
    path: String,
    token: String,
    dest: String,
    download_id: String,
) -> Result<u16, NetErr> {
    let ep = endpoint(&state, &address, fingerprint.as_deref())?;
    let mut last = 0u64;
    let status = ep
        .download_to(&path, &token, std::path::Path::new(&dest), |done, total| {
            if done.saturating_sub(last) > 256 * 1024 || Some(done) == total {
                last = done;
                let _ = app.emit("net://progress", Progress { id: &download_id, done, total });
            }
        })
        .await?;
    Ok(status)
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WsEvent {
    Message { data: String },
    Close { code: u16, reason: String },
}

#[tauri::command]
pub async fn ws_open(
    state: State<'_, NetState>,
    id: String,
    address: String,
    fingerprint: Option<String>,
    on_event: Channel<WsEvent>,
) -> Result<(), NetErr> {
    let ep = endpoint(&state, &address, fingerprint.as_deref())?;
    let ws = ep.connect_ws().await?;
    let (tx, mut rx) = mpsc::unbounded_channel::<WsCmd>();
    if let Some(old) = state.sockets.lock().unwrap_or_else(|p| p.into_inner()).insert(id.clone(), tx) {
        let _ = old.send(WsCmd::Close);
    }
    let (mut sink, mut stream) = ws.split();
    tauri::async_runtime::spawn(async move {
        let (code, reason) = loop {
            tokio::select! {
                cmd = rx.recv() => match cmd {
                    Some(WsCmd::Send(t)) => {
                        if sink.send(WsMessage::Text(t.into())).await.is_err() {
                            break (1006, "send failed".to_string());
                        }
                    }
                    Some(WsCmd::Close) | None => {
                        let _ = sink.send(WsMessage::Close(None)).await;
                        break (1000, "closed".to_string());
                    }
                },
                msg = stream.next() => match msg {
                    Some(Ok(WsMessage::Text(t))) => {
                        if on_event.send(WsEvent::Message { data: t.to_string() }).is_err() {
                            break (1001, "ui gone".to_string());
                        }
                    }
                    Some(Ok(WsMessage::Close(frame))) => {
                        break frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => break (1006, e.to_string()),
                    None => break (1006, "connection lost".to_string()),
                }
            }
        };
        let _ = on_event.send(WsEvent::Close { code, reason });
    });
    Ok(())
}

#[tauri::command]
pub fn ws_send(state: State<'_, NetState>, id: String, text: String) -> Result<(), String> {
    let map = state.sockets.lock().unwrap_or_else(|p| p.into_inner());
    let tx = map.get(&id).ok_or("not connected")?;
    tx.send(WsCmd::Send(text)).map_err(|_| "not connected".to_string())
}

#[tauri::command]
pub fn ws_close(state: State<'_, NetState>, id: String) {
    if let Some(tx) = state.sockets.lock().unwrap_or_else(|p| p.into_inner()).remove(&id) {
        let _ = tx.send(WsCmd::Close);
    }
}

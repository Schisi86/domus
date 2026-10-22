//! HTTP endpoints: server info, registration/login, file transfer, avatars.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::{Any, CorsLayer};

use crate::error::{ApiError, ApiResult, Code};
use crate::perms::{ATTACH_FILES, MANAGE_SERVER, VIEW_CHANNEL};
use crate::store::{self, InviteUse, RegistrationMode, User};
use crate::util::{clean_text, random_hex, sanitize_filename, sniff_image, validate_password, validate_username};
use crate::{auth, files, hub, ws, AppState};

const AVATAR_MAX: u64 = 2 * 1024 * 1024;

pub fn router(st: Arc<AppState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([header::AUTHORIZATION, header::CONTENT_TYPE]);
    Router::new()
        .route("/", get(root))
        .route("/api/v1/info", get(info))
        .route("/api/v1/auth/register", post(register))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/files", post(upload).layer(DefaultBodyLimit::disable()))
        .route("/api/v1/files/{id}", get(download))
        .route("/api/v1/avatar", post(avatar_upload).delete(avatar_delete).layer(DefaultBodyLimit::disable()))
        .route("/api/v1/avatars/{user_id}", get(avatar_get))
        .route("/api/v1/icon", get(icon_get).post(icon_upload).layer(DefaultBodyLimit::disable()))
        .route("/api/v1/ws", get(ws::ws_handler))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(cors)
        .with_state(st)
}

fn json_body<T: for<'de> Deserialize<'de>>(b: &Bytes) -> ApiResult<T> {
    serde_json::from_slice(b).map_err(|e| ApiError::bad(format!("Ungültige Anfrage: {e}")))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    headers.get(header::AUTHORIZATION)?.to_str().ok()?.strip_prefix("Bearer ")
}

pub async fn authed(st: &AppState, headers: &HeaderMap) -> ApiResult<User> {
    let token = bearer(headers).ok_or_else(|| ApiError::new(Code::Unauthorized, "Anmeldung erforderlich"))?;
    let th = auth::token_hash(token);
    let max_age = st.cfg.limits.session_days as i64 * 86_400_000;
    st.db
        .call(move |c| store::session_user(c, &th, max_age))
        .await?
        .ok_or_else(|| ApiError::new(Code::Unauthorized, "Sitzung ungültig oder abgelaufen"))
}

async fn root() -> &'static str {
    "NexusTalk-Server laeuft. Verbinde dich mit der NexusTalk-App.\n"
}

async fn info(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ws::server_public(&st))
}

#[derive(Deserialize)]
struct RegisterReq {
    username: String,
    password: String,
    invite: Option<String>,
    #[serde(default)]
    device: String,
}

fn device_name(d: &str) -> String {
    clean_text(d, 64, false, "Gerät").unwrap_or_default()
}

async fn register(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if !st.auth_limiter.check(addr.ip()) {
        return Err(ApiError::rate_limited());
    }
    let r: RegisterReq = json_body(&body)?;
    let username = r.username.trim().to_string();
    validate_username(&username)?;
    validate_password(&r.password)?;
    let mode = st.settings().registration_mode;
    let invite = r.invite.map(|i| i.trim().to_string()).filter(|i| !i.is_empty());
    if invite.is_none() && matches!(mode, RegistrationMode::Closed | RegistrationMode::Invite) {
        return Err(ApiError::new(Code::RegistrationClosed, "Registrierung nur mit Einladung möglich"));
    }
    let pw = r.password;
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&pw)).await.map_err(|_| ApiError::internal())??;
    let token = crate::util::random_token();
    let th = auth::token_hash(&token);
    let device = device_name(&r.device);
    let uname = username.clone();
    let (user, active, owner) = st
        .db
        .call(move |c| {
            let tx = c.transaction()?;
            let (status, owner, roles) = match &invite {
                Some(code) => match store::consume_invite(&tx, code)? {
                    InviteUse::OwnerSetup => ("active", true, store::admin_role_id(&tx)?.into_iter().collect()),
                    InviteUse::Normal { role_id: Some(r) } => ("active", false, vec![r]),
                    InviteUse::Normal { role_id: None } => ("active", false, store::default_role_ids(&tx)?),
                },
                None if mode == RegistrationMode::Approval => ("pending", false, Vec::new()),
                None => ("active", false, store::default_role_ids(&tx)?),
            };
            if mode == RegistrationMode::Closed && !owner {
                return Err(ApiError::new(Code::RegistrationClosed, "Registrierung ist geschlossen"));
            }
            let id = store::create_user(&tx, &uname, &hash, status, owner)?;
            store::add_user_roles(&tx, id, &roles)?;
            if status == "active" {
                store::create_session(&tx, id, &th, &device)?;
            }
            store::audit(&tx, Some(id), if owner { "owner.setup" } else { "user.register" }, &format!("user:{id}"), status);
            tx.commit()?;
            let u = store::user_by_id(c, id)?.ok_or_else(ApiError::internal)?;
            Ok((u, status == "active", owner))
        })
        .await?;
    tracing::info!(user = %user.username, ip = %addr.ip(), owner, active, "account registered");
    if owner {
        let _ = std::fs::remove_file(st.data_dir.join("setup-code.txt"));
    }
    if !active {
        return Ok(Json(json!({ "pending": true, "user": user })));
    }
    st.reload_perms().await?;
    let pc = st.perms();
    st.hub.broadcast(&hub::event("member.updated", &ws::member_json(&st, &pc, &user)), |_| true);
    Ok(Json(json!({ "token": token, "user": user })))
}

#[derive(Deserialize)]
struct LoginReq {
    username: String,
    password: String,
    #[serde(default)]
    device: String,
}

async fn login(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    if !st.auth_limiter.check(addr.ip()) {
        tracing::warn!(ip = %addr.ip(), "login rate limit hit");
        return Err(ApiError::rate_limited());
    }
    let r: LoginReq = json_body(&body)?;
    if r.username.len() > 64 || r.password.len() > 256 {
        return Err(ApiError::new(Code::InvalidCredentials, "Benutzername oder Passwort falsch"));
    }
    let name = r.username.trim().to_string();
    let found = st.db.call(move |c| store::user_by_name(c, &name)).await?;
    let (user, hash) = match found {
        Some((u, h)) => (Some(u), h),
        None => (None, auth::dummy_hash().to_string()),
    };
    let pw = r.password;
    let ok = tokio::task::spawn_blocking(move || auth::verify_password(&pw, &hash)).await.unwrap_or(false);
    let user = match (user, ok) {
        (Some(u), true) => u,
        _ => {
            tracing::warn!(username = %r.username.trim(), ip = %addr.ip(), "failed login");
            return Err(ApiError::new(Code::InvalidCredentials, "Benutzername oder Passwort falsch"));
        }
    };
    match user.status.as_str() {
        "active" => {}
        "pending" => return Err(ApiError::new(Code::AccountPending, "Konto wartet auf Freischaltung")),
        "banned" => return Err(ApiError::new(Code::AccountBanned, "Konto ist gesperrt")),
        _ => return Err(ApiError::new(Code::InvalidCredentials, "Benutzername oder Passwort falsch")),
    }
    let token = crate::util::random_token();
    let th = auth::token_hash(&token);
    let (uid, device) = (user.id, device_name(&r.device));
    st.db.call(move |c| store::create_session(c, uid, &th, &device)).await?;
    tracing::info!(user = %user.username, ip = %addr.ip(), "login");
    Ok(Json(json!({ "token": token, "user": user })))
}

async fn logout(State(st): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    if let Some(token) = bearer(&headers) {
        let th = auth::token_hash(token);
        st.db.call(move |c| store::delete_session(c, &th)).await?;
    }
    Ok(Json(json!({})))
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct UploadQuery {
    channel_id: i64,
    filename: String,
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers.get(header::CONTENT_LENGTH)?.to_str().ok()?.parse().ok()
}

async fn upload(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    if !st.upload_limiter.check(addr.ip()) {
        return Err(ApiError::rate_limited());
    }
    let user = authed(&st, &headers).await?;
    let settings = st.settings();
    if !settings.uploads_enabled {
        return Err(ApiError::new(Code::UploadsDisabled, "Dateiuploads sind auf diesem Server deaktiviert"));
    }
    {
        let pc = st.perms();
        if !pc.has_in(user.id, q.channel_id, VIEW_CHANNEL) {
            return Err(ApiError::not_found("Kanal"));
        }
        if !pc.has_in(user.id, q.channel_id, ATTACH_FILES) {
            return Err(ApiError::denied());
        }
    }
    let max = settings.max_upload_mb as u64 * 1_048_576;
    let announced = content_length(&headers);
    if announced.is_some_and(|l| l > max) {
        return Err(ApiError::new(Code::TooLarge, format!("Datei ist größer als {} MB", settings.max_upload_mb)));
    }
    let used = st.db.call(|c| store::storage_used(c)).await? as u64;
    let quota = settings.max_storage_mb as u64 * 1_048_576;
    if used + announced.unwrap_or(0) > quota {
        return Err(ApiError::new(Code::StorageFull, "Speicherplatz des Servers ist erschöpft"));
    }
    let filename = sanitize_filename(&q.filename);
    let id = random_hex(16);
    let tmp = st.uploads_dir().join(format!("tmp-{id}"));
    let rec = files::receive(body, &tmp, max.min(quota.saturating_sub(used))).await?;
    let mime = sniff_image(&rec.head).unwrap_or("application/octet-stream").to_string();
    let dest = st.uploads_dir().join(&id);
    tokio::fs::rename(&tmp, &dest).await?;
    let (id2, fname, m2, size, uid, cid) = (id.clone(), filename.clone(), mime.clone(), rec.size as i64, user.id, q.channel_id);
    if let Err(e) = st.db.call(move |c| store::insert_attachment(c, &id2, cid, uid, &fname, size, &m2)).await {
        let _ = tokio::fs::remove_file(&dest).await;
        return Err(e);
    }
    tracing::debug!(user = %user.username, size = rec.size, "file uploaded");
    Ok(Json(json!({ "id": id, "filename": filename, "size": rec.size, "mime": mime })))
}

fn file_response(path: std::path::PathBuf, mime: &str, disposition: Option<String>, len: u64, immutable: bool) -> Response {
    let file = match std::fs::File::open(&path) {
        Ok(f) => tokio::fs::File::from_std(f),
        Err(_) => return ApiError::not_found("Datei").into_response(),
    };
    let stream = tokio_util::io::ReaderStream::new(file);
    let mut resp = Response::new(Body::from_stream(stream));
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'none'; sandbox"));
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable { "private, max-age=31536000, immutable" } else { "private, no-cache" }),
    );
    if let Some(d) = disposition.and_then(|d| HeaderValue::from_str(&d).ok()) {
        h.insert(header::CONTENT_DISPOSITION, d);
    }
    resp
}

fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

async fn download(State(st): State<Arc<AppState>>, Path(id): Path<String>, headers: HeaderMap) -> Response {
    let user = match authed(&st, &headers).await {
        Ok(u) => u,
        Err(e) => return e.into_response(),
    };
    if !files::is_file_id(&id) {
        return ApiError::not_found("Datei").into_response();
    }
    let id2 = id.clone();
    let Ok(Some((att, channel_id, message_id, uploader))) = st.db.call(move |c| store::get_attachment(c, &id2)).await else {
        return ApiError::not_found("Datei").into_response();
    };
    let allowed = match message_id {
        Some(_) => st.perms().has_in(user.id, channel_id, VIEW_CHANNEL),
        None => uploader == user.id,
    };
    if !allowed {
        return ApiError::not_found("Datei").into_response();
    }
    let Some(path) = files::attachment_path(&st, &att.id) else { return ApiError::not_found("Datei").into_response() };
    let kind = if att.mime.starts_with("image/") { "inline" } else { "attachment" };
    let disp = format!("{kind}; filename*=UTF-8''{}", percent_encode(&att.filename));
    file_response(path, &att.mime, Some(disp), att.size as u64, true)
}

// ---------------------------------------------------------------------------
// Avatars & server icon
// ---------------------------------------------------------------------------

async fn store_image(st: &AppState, body: Body, prefix: &str) -> ApiResult<String> {
    let name = format!("{prefix}-{}", random_hex(8));
    let path = files::asset_path(st, &name).ok_or_else(ApiError::internal)?;
    let rec = files::receive(body, &path, AVATAR_MAX).await?;
    if sniff_image(&rec.head).is_none() {
        let _ = tokio::fs::remove_file(&path).await;
        return Err(ApiError::invalid("Nur PNG, JPEG, GIF oder WebP sind erlaubt"));
    }
    Ok(name)
}

fn serve_image(st: &AppState, name: &str) -> Response {
    let Some(path) = files::asset_path(st, name) else { return ApiError::not_found("Bild").into_response() };
    let mut head = [0u8; 16];
    let len = match std::fs::File::open(&path).and_then(|mut f| {
        use std::io::Read;
        let n = f.read(&mut head)?;
        Ok((n, f.metadata()?.len()))
    }) {
        Ok((n, len)) if sniff_image(&head[..n]).is_some() => len,
        _ => return ApiError::not_found("Bild").into_response(),
    };
    let mime = sniff_image(&head).unwrap_or("application/octet-stream");
    file_response(path, mime, None, len, true)
}

async fn avatar_upload(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    if !st.upload_limiter.check(addr.ip()) {
        return Err(ApiError::rate_limited());
    }
    let user = authed(&st, &headers).await?;
    let name = store_image(&st, body, &user.id.to_string()).await?;
    let (uid, n2) = (user.id, name.clone());
    let (old, u) = st.db.call(move |c| Ok((store::set_avatar(c, uid, Some(&n2))?, store::user_by_id(c, uid)?))).await?;
    if let Some(o) = old {
        files::remove_avatar(&st, &o);
    }
    if let Some(u) = u {
        crate::ops_social::broadcast_member(&st, &u);
    }
    Ok(Json(json!({ "avatar": name })))
}

async fn avatar_delete(State(st): State<Arc<AppState>>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let user = authed(&st, &headers).await?;
    let uid = user.id;
    let (old, u) = st.db.call(move |c| Ok((store::set_avatar(c, uid, None)?, store::user_by_id(c, uid)?))).await?;
    if let Some(o) = old {
        files::remove_avatar(&st, &o);
    }
    if let Some(u) = u {
        crate::ops_social::broadcast_member(&st, &u);
    }
    Ok(Json(json!({})))
}

async fn avatar_get(State(st): State<Arc<AppState>>, Path(user_id): Path<i64>, headers: HeaderMap) -> Response {
    if let Err(e) = authed(&st, &headers).await {
        return e.into_response();
    }
    match st.db.call(move |c| store::user_by_id(c, user_id)).await {
        Ok(Some(u)) => match u.avatar {
            Some(a) => serve_image(&st, &a),
            None => StatusCode::NOT_FOUND.into_response(),
        },
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn icon_get(State(st): State<Arc<AppState>>) -> Response {
    match st.settings().icon {
        Some(i) => serve_image(&st, &i),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn icon_upload(
    State(st): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Json<Value>> {
    if !st.upload_limiter.check(addr.ip()) {
        return Err(ApiError::rate_limited());
    }
    let user = authed(&st, &headers).await?;
    if !st.perms().has(user.id, MANAGE_SERVER) {
        return Err(ApiError::denied());
    }
    let name = store_image(&st, body, "icon").await?;
    let mut s = st.settings();
    let old = s.icon.replace(name.clone());
    let s2 = s.clone();
    st.db.call(move |c| store::put_settings(c, &s2)).await?;
    *st.settings.write().unwrap_or_else(|p| p.into_inner()) = s;
    if let Some(o) = old {
        files::remove_avatar(&st, &o);
    }
    st.hub.broadcast(&hub::event("server.updated", &ws::server_public(&st)), |_| true);
    Ok(Json(json!({ "icon": name })))
}

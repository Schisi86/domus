//! Structured error codes shared by the HTTP API and the WebSocket protocol.
//!
//! Clients translate the `code` into a localized message; `msg` is a German
//! fallback text meant for logs and for clients that do not know the code.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Code {
    BadRequest,
    Validation,
    Unauthorized,
    InvalidCredentials,
    AccountPending,
    AccountBanned,
    RegistrationClosed,
    InvalidInvite,
    UsernameTaken,
    PermissionDenied,
    NotFound,
    Conflict,
    RateLimited,
    TooLarge,
    UploadsDisabled,
    StorageFull,
    Blocked,
    VoiceFull,
    ServerFull,
    Internal,
}

#[derive(Debug, Clone, Serialize)]
pub struct ApiError {
    pub code: Code,
    pub msg: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(code: Code, msg: impl Into<String>) -> Self {
        Self { code, msg: msg.into() }
    }
    pub fn bad(msg: impl Into<String>) -> Self {
        Self::new(Code::BadRequest, msg)
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        Self::new(Code::Validation, msg)
    }
    pub fn denied() -> Self {
        Self::new(Code::PermissionDenied, "Keine Berechtigung")
    }
    pub fn not_found(what: &str) -> Self {
        Self::new(Code::NotFound, format!("{what} nicht gefunden"))
    }
    pub fn internal() -> Self {
        Self::new(Code::Internal, "Interner Serverfehler")
    }
    pub fn rate_limited() -> Self {
        Self::new(Code::RateLimited, "Zu viele Anfragen, bitte kurz warten")
    }

    pub fn status(&self) -> StatusCode {
        match self.code {
            Code::BadRequest | Code::Validation | Code::InvalidInvite | Code::UsernameTaken => StatusCode::BAD_REQUEST,
            Code::Unauthorized | Code::InvalidCredentials => StatusCode::UNAUTHORIZED,
            Code::AccountPending | Code::AccountBanned | Code::RegistrationClosed | Code::PermissionDenied
            | Code::UploadsDisabled | Code::Blocked => StatusCode::FORBIDDEN,
            Code::NotFound => StatusCode::NOT_FOUND,
            Code::Conflict | Code::VoiceFull => StatusCode::CONFLICT,
            Code::RateLimited => StatusCode::TOO_MANY_REQUESTS,
            Code::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Code::StorageFull => StatusCode::INSUFFICIENT_STORAGE,
            Code::ServerFull => StatusCode::SERVICE_UNAVAILABLE,
            Code::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.msg)
    }
}

/// Database errors are logged with detail but reported to clients generically.
impl From<rusqlite::Error> for ApiError {
    fn from(e: rusqlite::Error) -> Self {
        tracing::error!(error = %e, "database error");
        ApiError::internal()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        tracing::error!(error = %e, "io error");
        if e.kind() == std::io::ErrorKind::StorageFull {
            return ApiError::new(Code::StorageFull, "Kein Speicherplatz verfügbar");
        }
        ApiError::internal()
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status();
        (status, axum::Json(serde_json::json!({ "error": self }))).into_response()
    }
}

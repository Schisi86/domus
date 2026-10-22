//! On-disk storage for attachments, avatars and the server icon.
//!
//! Files are stored under random hexadecimal ids, never under client supplied
//! names, so path manipulation is impossible. The original (sanitized) file
//! name is kept in the database for display only.

use std::path::{Path, PathBuf};

use axum::body::Body;
use futures_util::StreamExt;
use tokio::io::AsyncWriteExt;

use crate::error::{ApiError, ApiResult, Code};
use crate::AppState;

pub fn is_file_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// Avatar / icon names look like `<digits>-<hex>` or `icon-<hex>`.
pub fn is_asset_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub fn attachment_path(st: &AppState, id: &str) -> Option<PathBuf> {
    is_file_id(id).then(|| st.uploads_dir().join(id))
}

pub fn asset_path(st: &AppState, name: &str) -> Option<PathBuf> {
    is_asset_name(name).then(|| st.uploads_dir().join("avatars").join(name))
}

pub fn remove_attachments(st: &AppState, ids: &[String]) {
    for id in ids {
        if let Some(p) = attachment_path(st, id) {
            if let Err(e) = std::fs::remove_file(&p) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, file = %id, "could not delete attachment");
                }
            }
        }
    }
}

pub fn remove_avatar(st: &AppState, name: &str) {
    if let Some(p) = asset_path(st, name) {
        let _ = std::fs::remove_file(p);
    }
}

pub struct Received {
    pub size: u64,
    pub head: Vec<u8>,
}

/// Streams a request body into `dest`, aborting once `max` bytes are exceeded.
/// The partial file is removed on any error.
pub async fn receive(body: Body, dest: &Path, max: u64) -> ApiResult<Received> {
    let res = async {
        let mut f = tokio::fs::File::create(dest).await?;
        let mut stream = body.into_data_stream();
        let mut size: u64 = 0;
        let mut head = Vec::with_capacity(16);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ApiError::bad("Upload abgebrochen"))?;
            size += chunk.len() as u64;
            if size > max {
                return Err(ApiError::new(Code::TooLarge, format!("Datei ist größer als {} MB", max / 1_048_576)));
            }
            if head.len() < 16 {
                let need = 16 - head.len();
                head.extend_from_slice(&chunk[..need.min(chunk.len())]);
            }
            f.write_all(&chunk).await?;
        }
        f.flush().await?;
        f.sync_all().await?;
        Ok(Received { size, head })
    }
    .await;
    if res.is_err() {
        let _ = tokio::fs::remove_file(dest).await;
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_names() {
        assert!(is_file_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_file_id("../../../../etc/passwd"));
        assert!(!is_file_id("0123456789ABCDEF0123456789ABCDEF"));
        assert!(is_asset_name("12-abcd"));
        assert!(!is_asset_name("..\\x"));
        assert!(!is_asset_name("a/b"));
    }

    #[tokio::test]
    async fn receive_enforces_limit() {
        let dir = std::env::temp_dir().join(format!("nx-files-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x");
        let r = receive(Body::from(vec![1u8; 100]), &p, 50).await;
        assert_eq!(r.err().unwrap().code, Code::TooLarge);
        assert!(!p.exists(), "partial file removed");
        let r = receive(Body::from(vec![2u8; 40]), &p, 50).await.unwrap();
        assert_eq!(r.size, 40);
        assert_eq!(r.head.len(), 16);
        std::fs::remove_dir_all(&dir).ok();
    }
}

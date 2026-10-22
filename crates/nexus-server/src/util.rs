//! Small helpers: time, randomness, input validation.

use rand_core::{OsRng, RngCore};
use base64::Engine;

use crate::error::{ApiError, ApiResult};

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// URL-safe random token with 256 bits of entropy.
pub fn random_token() -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<32>())
}

pub fn random_hex(bytes: usize) -> String {
    let mut b = vec![0u8; bytes];
    OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

/// Human friendly invite code (no ambiguous characters).
pub fn random_code(len: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut b = vec![0u8; len];
    OsRng.fill_bytes(&mut b);
    b.iter().map(|x| ALPHABET[(*x as usize) % ALPHABET.len()] as char).collect()
}

pub fn validate_username(name: &str) -> ApiResult<()> {
    let len = name.chars().count();
    if !(2..=32).contains(&len) {
        return Err(ApiError::invalid("Benutzername muss 2 bis 32 Zeichen lang sein"));
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err(ApiError::invalid("Benutzername darf nur Buchstaben, Ziffern, '_', '-' und '.' enthalten"));
    }
    if name.starts_with('.') || name.starts_with('-') {
        return Err(ApiError::invalid("Benutzername darf nicht mit '.' oder '-' beginnen"));
    }
    Ok(())
}

pub fn validate_password(pw: &str) -> ApiResult<()> {
    let len = pw.chars().count();
    if len < 8 {
        return Err(ApiError::invalid("Passwort muss mindestens 8 Zeichen lang sein"));
    }
    if pw.len() > 256 {
        return Err(ApiError::invalid("Passwort ist zu lang"));
    }
    Ok(())
}

/// Trims and checks a free-text field. Rejects control characters other than
/// newline and tab, which protects logs and UIs from injected escape sequences.
pub fn clean_text(s: &str, max_chars: usize, allow_newlines: bool, field: &str) -> ApiResult<String> {
    let s = s.replace("\r\n", "\n").replace('\r', "\n");
    let s = s.trim();
    if s.chars().count() > max_chars {
        return Err(ApiError::invalid(format!("{field}: höchstens {max_chars} Zeichen")));
    }
    if s.chars().any(|c| c.is_control() && !(allow_newlines && (c == '\n' || c == '\t'))) {
        return Err(ApiError::invalid(format!("{field}: enthält unzulässige Steuerzeichen")));
    }
    Ok(s.to_string())
}

pub fn clean_name(s: &str, max_chars: usize, field: &str) -> ApiResult<String> {
    let s = clean_text(s, max_chars, false, field)?;
    if s.is_empty() {
        return Err(ApiError::invalid(format!("{field}: darf nicht leer sein")));
    }
    Ok(s)
}

/// Makes an uploaded file name safe for display and for `Content-Disposition`.
/// The name is never used as a path on disk; files are stored under random ids.
pub fn sanitize_filename(name: &str) -> String {
    // Keep only the last path component, whatever separator the client used.
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let mut out: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    out = out.trim().trim_matches('.').to_string();
    if out.chars().count() > 120 {
        out = out.chars().take(120).collect();
    }
    if out.is_empty() {
        out = "datei".into();
    }
    out
}

/// Recognizes common image formats by magic bytes. Anything else is served as
/// an opaque download.
pub fn sniff_image(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usernames() {
        assert!(validate_username("anna_93").is_ok());
        assert!(validate_username("a").is_err());
        assert!(validate_username("bad name").is_err());
        assert!(validate_username("../etc").is_err());
        assert!(validate_username(".hidden").is_err());
        assert!(validate_username(&"x".repeat(33)).is_err());
    }

    #[test]
    fn passwords() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("long enough").is_ok());
        assert!(validate_password(&"x".repeat(300)).is_err());
    }

    #[test]
    fn filenames_cannot_escape() {
        assert_eq!(sanitize_filename("../../windows/system32/evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("C:\\Users\\x\\a.txt"), "a.txt");
        assert_eq!(sanitize_filename("..."), "datei");
        assert_eq!(sanitize_filename("a<b>c?.png"), "a_b_c_.png");
        assert_eq!(sanitize_filename("x\u{0000}y\u{202e}.txt").contains('\u{0}'), false);
        assert_eq!(sanitize_filename(&"n".repeat(500)).chars().count(), 120);
    }

    #[test]
    fn text_validation() {
        assert_eq!(clean_text("  hi\r\nthere ", 100, true, "x").unwrap(), "hi\nthere");
        assert!(clean_text("a\u{1b}[31m", 100, true, "x").is_err());
        assert!(clean_text("line\nbreak", 100, false, "x").is_err());
        assert!(clean_text(&"x".repeat(11), 10, true, "x").is_err());
        assert!(clean_name("   ", 10, "x").is_err());
    }

    #[test]
    fn image_sniffing() {
        assert_eq!(sniff_image(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(sniff_image(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image(b"<html>"), None);
    }

    #[test]
    fn tokens_are_unique() {
        assert_ne!(random_token(), random_token());
        assert_eq!(random_code(8).len(), 8);
    }
}

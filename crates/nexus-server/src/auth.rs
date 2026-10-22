//! Password hashing (Argon2id) and session token handling.
//!
//! Session tokens are random 256-bit values. Only their SHA-256 hash is stored,
//! so a leaked database does not allow taking over sessions.

use rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use sha2::{Digest, Sha256};

use crate::error::{ApiError, ApiResult};

pub fn hash_password(pw: &str) -> ApiResult<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| {
            tracing::error!(error = %e, "password hashing failed");
            ApiError::internal()
        })
}

pub fn verify_password(pw: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(h) => Argon2::default().verify_password(pw.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}

/// A valid hash used to equalize timing when a user name does not exist.
pub fn dummy_hash() -> &'static str {
    static H: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    H.get_or_init(|| hash_password("nexustalk-timing-equalizer").unwrap_or_default())
}

pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

/// HMAC-based short-lived credentials for the built-in TURN relay, following the
/// "TURN REST API" convention (username = expiry timestamp).
pub fn turn_credentials(secret: &str, ttl_secs: u64) -> Option<(String, String)> {
    turn::auth::generate_long_term_credentials(secret, std::time::Duration::from_secs(ttl_secs)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_and_verify() {
        let h = hash_password("korrekt pferd").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(!h.contains("korrekt"));
        assert!(verify_password("korrekt pferd", &h));
        assert!(!verify_password("falsch", &h));
        assert!(!verify_password("x", "not a hash"));
        assert_ne!(hash_password("same").unwrap(), hash_password("same").unwrap(), "salted");
    }

    #[test]
    fn token_hashes_are_stable() {
        assert_eq!(token_hash("abc"), token_hash("abc"));
        assert_ne!(token_hash("abc"), token_hash("abd"));
        assert_eq!(token_hash("abc").len(), 32);
    }
}

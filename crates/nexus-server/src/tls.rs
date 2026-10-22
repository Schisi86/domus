//! TLS certificate handling. Without a configured certificate the server
//! generates a self-signed one on first start and keeps it. Clients pin its
//! SHA-256 fingerprint (shown in the UI and embedded in invite links).

use std::path::Path;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use sha2::{Digest, Sha256};

use crate::config::TlsConfig;

pub struct TlsMaterial {
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
    /// Upper-case hex SHA-256 of the leaf certificate (DER).
    pub fingerprint: String,
    pub self_signed: bool,
}

pub fn fingerprint_der(der: &[u8]) -> String {
    hex::encode_upper(Sha256::digest(der))
}

fn leaf_fingerprint(cert_pem: &[u8]) -> std::io::Result<String> {
    let first = CertificateDer::pem_slice_iter(cert_pem)
        .next()
        .ok_or_else(|| std::io::Error::other("Zertifikatsdatei enthält kein Zertifikat"))?
        .map_err(|e| std::io::Error::other(format!("Zertifikat ungültig: {e}")))?;
    Ok(fingerprint_der(first.as_ref()))
}

pub fn load_or_create(cfg: &TlsConfig, data_dir: &Path, extra_names: &[String]) -> std::io::Result<TlsMaterial> {
    if !cfg.cert_path.is_empty() {
        let cert_pem = std::fs::read(&cfg.cert_path)?;
        let key_pem = std::fs::read(&cfg.key_path)?;
        let fingerprint = leaf_fingerprint(&cert_pem)?;
        return Ok(TlsMaterial { cert_pem, key_pem, fingerprint, self_signed: false });
    }
    let dir = data_dir.join("tls");
    let (cp, kp) = (dir.join("cert.pem"), dir.join("key.pem"));
    if cp.exists() && kp.exists() {
        let cert_pem = std::fs::read(&cp)?;
        let key_pem = std::fs::read(&kp)?;
        let fingerprint = leaf_fingerprint(&cert_pem)?;
        return Ok(TlsMaterial { cert_pem, key_pem, fingerprint, self_signed: true });
    }
    std::fs::create_dir_all(&dir)?;
    let mut names = vec!["localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    for n in extra_names {
        if !n.is_empty() && !names.contains(n) {
            names.push(n.clone());
        }
    }
    let ck = rcgen::generate_simple_self_signed(names).map_err(|e| std::io::Error::other(e.to_string()))?;
    let cert_pem = ck.cert.pem().into_bytes();
    let key_pem = ck.signing_key.serialize_pem().into_bytes();
    std::fs::write(&cp, &cert_pem)?;
    std::fs::write(&kp, &key_pem)?;
    let fingerprint = fingerprint_der(ck.cert.der());
    tracing::info!(%fingerprint, "generated self-signed TLS certificate");
    Ok(TlsMaterial { cert_pem, key_pem, fingerprint, self_signed: true })
}

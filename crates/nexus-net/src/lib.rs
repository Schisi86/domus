//! Client-side networking for Domus: HTTP requests and WebSocket
//! connections over TLS with certificate pinning.
//!
//! Self-hosted servers usually run with a self-signed certificate. Instead of
//! disabling verification, the client pins the certificate's SHA-256
//! fingerprint ("trust on first use", like SSH):
//!
//! * pinned fingerprint given → the leaf certificate must match exactly;
//! * no pin → the certificate must chain to a public root (webpki-roots);
//!   otherwise [`NetError::Untrusted`] reports the fingerprint so the UI can
//!   ask the user to confirm it.

use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{ring, verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};

pub use tokio_tungstenite::tungstenite::Message as WsMessage;
pub type WsStream = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

#[derive(Debug, Clone, thiserror::Error, PartialEq)]
pub enum NetError {
    #[error("Unbekanntes Zertifikat (Fingerabdruck {fingerprint})")]
    Untrusted { fingerprint: String },
    #[error("Zertifikat hat sich geändert! Erwartet {expected}, erhalten {actual}")]
    Mismatch { expected: String, actual: String },
    #[error("Ungültige Adresse: {0}")]
    BadUrl(String),
    #[error("Verbindung fehlgeschlagen: {0}")]
    Connect(String),
    #[error("Zeitüberschreitung")]
    Timeout,
}

pub fn fingerprint(der: &[u8]) -> String {
    hex::encode_upper(Sha256::digest(der))
}

/// Normalizes user input like `AB:CD:..` or lower-case hex.
pub fn normalize_fingerprint(fp: &str) -> String {
    fp.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_uppercase()
}

#[derive(Debug)]
struct PinVerifier {
    pin: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    provider: Arc<CryptoProvider>,
    webpki: Arc<rustls::client::WebPkiServerVerifier>,
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        *self.seen.lock().unwrap_or_else(|p| p.into_inner()) = Some(fp.clone());
        match &self.pin {
            Some(pin) if *pin == fp => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::General("nexus:pin-mismatch".into())),
            None => self
                .webpki
                .verify_server_cert(end_entity, intermediates, server_name, ocsp, now)
                .map_err(|_| rustls::Error::General("nexus:untrusted".into())),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Target server plus the TLS configuration used for every connection to it.
#[derive(Clone)]
pub struct Endpoint {
    /// `https://host:port` or `http://host:port` (no trailing slash).
    pub base: String,
    pub tls: bool,
    pin: Option<String>,
    seen: Arc<Mutex<Option<String>>>,
    config: Option<Arc<ClientConfig>>,
    http: reqwest::Client,
}

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

/// Parses `host`, `host:port`, `https://host:port` or `http://host:port`.
/// Without a scheme TLS is assumed; the default port is 7878.
pub fn parse_address(input: &str) -> Result<(bool, String), NetError> {
    let s = input.trim().trim_end_matches('/');
    let (tls, rest) = if let Some(r) = s.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = s.strip_prefix("http://") {
        (false, r)
    } else if let Some(r) = s.strip_prefix("domus://").or_else(|| s.strip_prefix("nexustalk://")) {
        (true, r)
    } else {
        (true, s)
    };
    let hostport = rest.split('/').next().unwrap_or("");
    if hostport.is_empty() || hostport.contains(char::is_whitespace) {
        return Err(NetError::BadUrl(input.to_string()));
    }
    let with_port = if hostport.starts_with('[') {
        if hostport.contains("]:") { hostport.to_string() } else { format!("{hostport}:7878") }
    } else if hostport.matches(':').count() == 1 {
        hostport.to_string()
    } else if hostport.contains(':') {
        format!("[{hostport}]:7878")
    } else {
        format!("{hostport}:7878")
    };
    let url = format!("{}://{}", if tls { "https" } else { "http" }, with_port);
    url::Url::parse(&url).map_err(|_| NetError::BadUrl(input.to_string()))?;
    Ok((tls, url))
}

impl Endpoint {
    pub fn new(address: &str, pin: Option<&str>) -> Result<Endpoint, NetError> {
        let (tls, base) = parse_address(address)?;
        let provider = Arc::new(ring::default_provider());
        let _ = ring::default_provider().install_default();
        let seen = Arc::new(Mutex::new(None));
        let pin = pin.map(normalize_fingerprint).filter(|p| !p.is_empty());
        let config = if tls {
            let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
                .build()
                .map_err(|e| NetError::Connect(e.to_string()))?;
            let verifier = Arc::new(PinVerifier { pin: pin.clone(), seen: seen.clone(), provider: provider.clone(), webpki });
            let cfg = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| NetError::Connect(e.to_string()))?
                .dangerous()
                .with_custom_certificate_verifier(verifier)
                .with_no_client_auth();
            Some(Arc::new(cfg))
        } else {
            None
        };
        let mut b = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(8))
            .timeout(std::time::Duration::from_secs(600))
            .http1_only()
            .no_proxy();
        if let Some(cfg) = &config {
            b = b.use_preconfigured_tls((**cfg).clone());
        }
        let http = b.build().map_err(|e| NetError::Connect(e.to_string()))?;
        Ok(Endpoint { base, tls, pin, seen, config, http })
    }

    /// Fingerprint of the certificate seen during the last TLS handshake.
    pub fn seen_fingerprint(&self) -> Option<String> {
        self.seen.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn classify(&self, err: impl std::fmt::Display + std::fmt::Debug) -> NetError {
        let text = format!("{err:?}");
        let seen = self.seen_fingerprint();
        if text.contains("nexus:pin-mismatch") {
            return NetError::Mismatch { expected: self.pin.clone().unwrap_or_default(), actual: seen.unwrap_or_default() };
        }
        if text.contains("nexus:untrusted") {
            return NetError::Untrusted { fingerprint: seen.unwrap_or_default() };
        }
        let mut msg = err.to_string();
        if msg.len() > 300 {
            msg.truncate(300);
        }
        if text.contains("TimedOut") || text.contains("timed out") {
            return NetError::Timeout;
        }
        // The top-level message ("error sending request") hides the cause; the
        // UI explains "PC reachable, but no server on that port" for this one.
        if text.contains("ConnectionRefused") || text.contains("10061") || text.contains("Connection refused") {
            return NetError::Connect(format!("connection refused: {msg}"));
        }
        NetError::Connect(msg)
    }

    pub async fn request(
        &self,
        method: &str,
        path: &str,
        bearer: Option<&str>,
        body: Option<Vec<u8>>,
        content_type: Option<&str>,
    ) -> Result<HttpResponse, NetError> {
        let m = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| NetError::BadUrl(method.into()))?;
        let mut rb = self.http.request(m, format!("{}{}", self.base, path));
        if let Some(t) = bearer {
            rb = rb.bearer_auth(t);
        }
        if let Some(ct) = content_type {
            rb = rb.header("content-type", ct);
        }
        if let Some(b) = body {
            rb = rb.body(b);
        }
        let resp = rb.send().await.map_err(|e| self.classify(e))?;
        let status = resp.status().as_u16();
        let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
        let body = resp.bytes().await.map_err(|e| self.classify(e))?.to_vec();
        Ok(HttpResponse { status, body, content_type })
    }

    /// Uploads a body and reports progress (bytes sent) through `progress`.
    pub async fn upload(
        &self,
        path: &str,
        bearer: &str,
        data: Vec<u8>,
        progress: impl Fn(u64, u64) + Send + Sync + 'static,
    ) -> Result<HttpResponse, NetError> {
        let total = data.len() as u64;
        let data = bytes_chunks(data);
        let progress = Arc::new(progress);
        let sent = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let stream = futures_util::stream::iter(data.into_iter().map(move |chunk| {
            let n = sent.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed) + chunk.len() as u64;
            progress(n, total);
            Ok::<_, std::io::Error>(chunk)
        }));
        let resp = self
            .http
            .post(format!("{}{}", self.base, path))
            .bearer_auth(bearer)
            .header("content-length", total)
            .header("content-type", "application/octet-stream")
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .map_err(|e| self.classify(e))?;
        let status = resp.status().as_u16();
        let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
        let body = resp.bytes().await.map_err(|e| self.classify(e))?.to_vec();
        Ok(HttpResponse { status, body, content_type })
    }

    /// Downloads into a file, reporting progress. Returns the HTTP status.
    pub async fn download_to(
        &self,
        path: &str,
        bearer: &str,
        dest: &std::path::Path,
        mut progress: impl FnMut(u64, Option<u64>),
    ) -> Result<u16, NetError> {
        use futures_util::StreamExt;
        use tokio::io::AsyncWriteExt;
        let resp = self
            .http
            .get(format!("{}{}", self.base, path))
            .bearer_auth(bearer)
            .send()
            .await
            .map_err(|e| self.classify(e))?;
        let status = resp.status().as_u16();
        if status != 200 {
            return Ok(status);
        }
        let total = resp.content_length();
        let tmp = dest.with_extension("part");
        let mut f = tokio::fs::File::create(&tmp).await.map_err(|e| NetError::Connect(e.to_string()))?;
        let mut stream = resp.bytes_stream();
        let mut done = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| self.classify(e))?;
            f.write_all(&chunk).await.map_err(|e| NetError::Connect(e.to_string()))?;
            done += chunk.len() as u64;
            progress(done, total);
        }
        f.flush().await.map_err(|e| NetError::Connect(e.to_string()))?;
        drop(f);
        tokio::fs::rename(&tmp, dest).await.map_err(|e| NetError::Connect(e.to_string()))?;
        Ok(status)
    }

    pub fn ws_url(&self) -> String {
        let rest = self.base.split_once("://").map(|x| x.1).unwrap_or(&self.base);
        format!("{}://{}/api/v1/ws", if self.tls { "wss" } else { "ws" }, rest)
    }

    pub async fn connect_ws(&self) -> Result<WsStream, NetError> {
        use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
        use tokio_tungstenite::Connector;
        let connector = match &self.config {
            Some(c) => Connector::Rustls(c.clone()),
            None => Connector::Plain,
        };
        let cfg = WebSocketConfig::default().max_message_size(Some(4 << 20)).max_frame_size(Some(4 << 20));
        let fut = tokio_tungstenite::connect_async_tls_with_config(self.ws_url(), Some(cfg), false, Some(connector));
        match tokio::time::timeout(std::time::Duration::from_secs(10), fut).await {
            Err(_) => Err(NetError::Timeout),
            Ok(Err(e)) => Err(self.classify(e)),
            Ok(Ok((ws, _))) => Ok(ws),
        }
    }
}

fn bytes_chunks(data: Vec<u8>) -> Vec<Vec<u8>> {
    const CHUNK: usize = 64 * 1024;
    if data.len() <= CHUNK {
        return vec![data];
    }
    data.chunks(CHUNK).map(|c| c.to_vec()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(parse_address("example.org").unwrap(), (true, "https://example.org:7878".into()));
        assert_eq!(parse_address("192.168.1.5:9000").unwrap(), (true, "https://192.168.1.5:9000".into()));
        assert_eq!(parse_address("http://localhost:7878/").unwrap(), (false, "http://localhost:7878".into()));
        assert_eq!(parse_address("nexustalk://host:1/ABC").unwrap(), (true, "https://host:1".into()));
        assert_eq!(parse_address("domus://host:1/ABC").unwrap(), (true, "https://host:1".into()));
        assert_eq!(parse_address("::1").unwrap(), (true, "https://[::1]:7878".into()));
        assert_eq!(parse_address("[::1]:80").unwrap(), (true, "https://[::1]:80".into()));
        assert!(parse_address("").is_err());
        assert!(parse_address("bad host").is_err());
    }

    #[test]
    fn fingerprints() {
        assert_eq!(normalize_fingerprint("ab:cd:EF"), "ABCDEF");
        assert_eq!(fingerprint(b"x").len(), 64);
    }

    #[test]
    fn ws_urls() {
        let e = Endpoint::new("localhost:7878", None).unwrap();
        assert_eq!(e.ws_url(), "wss://localhost:7878/api/v1/ws");
        let e = Endpoint::new("http://127.0.0.1:9", None).unwrap();
        assert_eq!(e.ws_url(), "ws://127.0.0.1:9/api/v1/ws");
    }
}

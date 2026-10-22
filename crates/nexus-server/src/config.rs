//! Server configuration (`server.toml`).
//!
//! Network-level settings that require a restart live here. Community settings
//! that admins may change at runtime (name, registration mode, upload limits, ...)
//! are stored in the database, see [`crate::store::ServerSettings`].

use std::net::IpAddr;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Config {
    /// Address to listen on. Defaults to loopback so a fresh install is never
    /// reachable from the network by accident.
    pub bind: String,
    pub port: u16,
    /// Host name or IP that other people use to reach this server. Only used to
    /// build invite links.
    pub public_host: String,
    pub tls: TlsConfig,
    pub media: MediaConfig,
    pub limits: LimitsConfig,
    pub log: LogConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TlsConfig {
    pub enabled: bool,
    /// PEM certificate chain. Empty = generate and reuse a self-signed certificate.
    pub cert_path: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MediaConfig {
    /// Built-in STUN responder on `udp_port` (lets clients learn their public address).
    pub stun_enabled: bool,
    /// Built-in TURN relay on `udp_port`. Relays media when no direct path exists.
    pub turn_enabled: bool,
    pub udp_port: u16,
    /// IP announced for TURN relay allocations. Empty = auto-detect primary LAN IP.
    pub relay_ip: String,
    pub relay_port_min: u16,
    pub relay_port_max: u16,
    /// Additional ICE servers handed to clients (e.g. an external coturn).
    pub ice_servers: Vec<IceServer>,
    pub max_voice_participants: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LimitsConfig {
    pub max_connections: usize,
    pub max_connections_per_ip: usize,
    /// Sustained WebSocket operations per second per connection.
    pub ops_per_sec: f64,
    pub ops_burst: f64,
    pub messages_per_sec: f64,
    pub messages_burst: f64,
    /// Login/registration attempts per minute per IP.
    pub auth_per_min: f64,
    pub auth_burst: f64,
    pub session_days: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct LogConfig {
    /// `error`, `warn`, `info`, `debug` or `trace`.
    pub level: String,
    /// Number of daily log files to keep.
    pub max_files: usize,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1".into(),
            port: 7878,
            public_host: String::new(),
            tls: TlsConfig::default(),
            media: MediaConfig::default(),
            limits: LimitsConfig::default(),
            log: LogConfig::default(),
        }
    }
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self { enabled: true, cert_path: String::new(), key_path: String::new() }
    }
}

impl Default for MediaConfig {
    fn default() -> Self {
        Self {
            stun_enabled: true,
            turn_enabled: false,
            udp_port: 3478,
            relay_ip: String::new(),
            relay_port_min: 49160,
            relay_port_max: 49200,
            ice_servers: Vec::new(),
            max_voice_participants: 10,
        }
    }
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_connections: 500,
            max_connections_per_ip: 20,
            ops_per_sec: 10.0,
            ops_burst: 40.0,
            messages_per_sec: 2.0,
            messages_burst: 10.0,
            auth_per_min: 6.0,
            auth_burst: 10.0,
            session_days: 30,
        }
    }
}

impl Default for LogConfig {
    fn default() -> Self {
        Self { level: "info".into(), max_files: 7 }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Konfigurationsdatei konnte nicht gelesen werden: {0}")]
    Io(#[from] std::io::Error),
    #[error("Konfigurationsdatei ist beschädigt: {0}")]
    Parse(String),
    #[error("Ungültige Konfiguration: {}", .0.join("; "))]
    Invalid(Vec<String>),
}

impl Config {
    /// Loads the config file; a missing file yields the defaults.
    pub fn load(path: &Path) -> Result<Config, ConfigError> {
        if !path.exists() {
            return Ok(Config::default());
        }
        let text = std::fs::read_to_string(path)?;
        let cfg: Config = toml::from_str(&text).map_err(|e| ConfigError::Parse(e.to_string()))?;
        cfg.validate().map_err(ConfigError::Invalid)?;
        Ok(cfg)
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        self.validate().map_err(ConfigError::Invalid)?;
        let text = toml::to_string_pretty(self).map_err(|e| ConfigError::Parse(e.to_string()))?;
        let tmp = path.with_extension("toml.tmp");
        std::fs::write(&tmp, text)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn validate(&self) -> Result<(), Vec<String>> {
        let mut errs = Vec::new();
        if self.bind.parse::<IpAddr>().is_err() {
            errs.push(format!("bind: '{}' ist keine gültige IP-Adresse", self.bind));
        }
        if self.port == 0 {
            errs.push("port: darf nicht 0 sein".into());
        }
        if self.tls.cert_path.is_empty() != self.tls.key_path.is_empty() {
            errs.push("tls: cert_path und key_path müssen gemeinsam gesetzt werden".into());
        }
        if (self.media.stun_enabled || self.media.turn_enabled) && self.media.udp_port == 0 {
            errs.push("media.udp_port: darf nicht 0 sein".into());
        }
        if self.media.turn_enabled {
            if !self.media.relay_ip.is_empty() && self.media.relay_ip.parse::<IpAddr>().is_err() {
                errs.push("media.relay_ip: keine gültige IP-Adresse".into());
            }
            if self.media.relay_port_min == 0 || self.media.relay_port_min > self.media.relay_port_max {
                errs.push("media.relay_port_min/max: ungültiger Portbereich".into());
            }
        }
        for s in &self.media.ice_servers {
            if s.urls.is_empty()
                || s.urls.iter().any(|u| !(u.starts_with("stun:") || u.starts_with("turn:") || u.starts_with("turns:")))
            {
                errs.push("media.ice_servers: URLs müssen mit stun:, turn: oder turns: beginnen".into());
            }
        }
        if !(1..=50).contains(&self.media.max_voice_participants) {
            errs.push("media.max_voice_participants: erlaubt sind 1 bis 50".into());
        }
        let l = &self.limits;
        if l.max_connections == 0 || l.max_connections_per_ip == 0 {
            errs.push("limits: Verbindungslimits müssen größer als 0 sein".into());
        }
        for (name, v) in [
            ("ops_per_sec", l.ops_per_sec),
            ("ops_burst", l.ops_burst),
            ("messages_per_sec", l.messages_per_sec),
            ("messages_burst", l.messages_burst),
            ("auth_per_min", l.auth_per_min),
            ("auth_burst", l.auth_burst),
        ] {
            if !(v.is_finite() && v > 0.0) {
                errs.push(format!("limits.{name}: muss größer als 0 sein"));
            }
        }
        if l.session_days == 0 || l.session_days > 365 {
            errs.push("limits.session_days: erlaubt sind 1 bis 365".into());
        }
        if !["error", "warn", "info", "debug", "trace"].contains(&self.log.level.as_str()) {
            errs.push("log.level: erlaubt sind error, warn, info, debug, trace".into());
        }
        if errs.is_empty() { Ok(()) } else { Err(errs) }
    }

    /// True when the server listens on something other than loopback.
    pub fn is_exposed(&self) -> bool {
        self.bind.parse::<IpAddr>().map(|ip| !ip.is_loopback()).unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_private() {
        let c = Config::default();
        assert!(c.validate().is_ok());
        assert!(!c.is_exposed(), "default must bind to loopback");
        assert!(c.tls.enabled, "TLS must be on by default");
        assert!(!c.media.turn_enabled);
    }

    #[test]
    fn rejects_invalid_values() {
        let mut c = Config::default();
        c.bind = "not-an-ip".into();
        c.port = 0;
        c.log.level = "loud".into();
        c.tls.cert_path = "cert.pem".into();
        let errs = c.validate().unwrap_err();
        assert_eq!(errs.len(), 4, "{errs:?}");
    }

    #[test]
    fn rejects_bad_ice_urls_and_ranges() {
        let mut c = Config::default();
        c.media.turn_enabled = true;
        c.media.relay_port_min = 5000;
        c.media.relay_port_max = 4000;
        c.media.ice_servers.push(IceServer { urls: vec!["http://x".into()], username: None, credential: None });
        assert_eq!(c.validate().unwrap_err().len(), 2);
    }

    #[test]
    fn roundtrip_and_partial_file() {
        let dir = std::env::temp_dir().join(format!("nx-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("server.toml");
        std::fs::write(&p, "port = 9000\n[tls]\nenabled = false\n").unwrap();
        let c = Config::load(&p).unwrap();
        assert_eq!(c.port, 9000);
        assert!(!c.tls.enabled);
        assert_eq!(c.bind, "127.0.0.1");
        c.save(&p).unwrap();
        assert_eq!(Config::load(&p).unwrap(), c);
        std::fs::write(&p, "port = [broken").unwrap();
        assert!(matches!(Config::load(&p), Err(ConfigError::Parse(_))));
        std::fs::remove_dir_all(&dir).ok();
    }
}

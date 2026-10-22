//! NAT traversal helpers on a UDP port: a minimal STUN binding responder
//! (RFC 5389) or, when enabled, a full TURN relay (webrtc-rs `turn` crate).
//!
//! Audio/video itself never passes through the application server. Media goes
//! peer to peer; only when no direct path exists does it go via TURN.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use tokio::net::UdpSocket;

use crate::config::MediaConfig;

const MAGIC: u32 = 0x2112_A442;

/// Builds a Binding Success Response for a Binding Request, or `None` if the
/// packet is not a well-formed STUN binding request.
pub fn stun_binding_response(req: &[u8], from: SocketAddr) -> Option<Vec<u8>> {
    if req.len() < 20 || req[0] & 0xC0 != 0 {
        return None;
    }
    let msg_type = u16::from_be_bytes([req[0], req[1]]);
    let cookie = u32::from_be_bytes([req[4], req[5], req[6], req[7]]);
    if msg_type != 0x0001 || cookie != MAGIC {
        return None;
    }
    let txid = &req[8..20];
    let mut attr = Vec::with_capacity(24);
    let xport = from.port() ^ (MAGIC >> 16) as u16;
    match from.ip() {
        IpAddr::V4(ip) => {
            attr.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
            attr.extend_from_slice(&xport.to_be_bytes());
            let x = u32::from(ip) ^ MAGIC;
            attr.extend_from_slice(&x.to_be_bytes());
        }
        IpAddr::V6(ip) => {
            attr.extend_from_slice(&[0x00, 0x20, 0x00, 0x14, 0x00, 0x02]);
            attr.extend_from_slice(&xport.to_be_bytes());
            let mut key = [0u8; 16];
            key[..4].copy_from_slice(&MAGIC.to_be_bytes());
            key[4..].copy_from_slice(txid);
            for (o, k) in ip.octets().iter().zip(key) {
                attr.push(o ^ k);
            }
        }
    }
    let mut out = Vec::with_capacity(20 + attr.len());
    out.extend_from_slice(&0x0101u16.to_be_bytes());
    out.extend_from_slice(&(attr.len() as u16).to_be_bytes());
    out.extend_from_slice(&MAGIC.to_be_bytes());
    out.extend_from_slice(txid);
    out.extend_from_slice(&attr);
    Some(out)
}

/// Primary local IP (the one used for the default route). No packet is sent.
pub fn primary_local_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

pub enum MediaService {
    Stun(tokio::task::JoinHandle<()>),
    Turn(turn::server::Server),
}

impl MediaService {
    pub async fn stop(self) {
        match self {
            MediaService::Stun(h) => h.abort(),
            MediaService::Turn(s) => {
                let _ = s.close().await;
            }
        }
    }
}

pub async fn start(cfg: &MediaConfig, bind: IpAddr, turn_secret: &str) -> std::io::Result<Option<MediaService>> {
    if !cfg.stun_enabled && !cfg.turn_enabled {
        return Ok(None);
    }
    let sock = UdpSocket::bind(SocketAddr::new(bind, cfg.udp_port)).await?;
    if cfg.turn_enabled {
        use turn::relay::relay_range::RelayAddressGeneratorRanges;
        use turn::server::config::{ConnConfig, ServerConfig};
        let relay_ip = if cfg.relay_ip.is_empty() {
            if bind.is_unspecified() { primary_local_ip().unwrap_or(bind) } else { bind }
        } else {
            cfg.relay_ip.parse().map_err(|_| std::io::Error::other("relay_ip ungültig"))?
        };
        let server = turn::server::Server::new(ServerConfig {
            conn_configs: vec![ConnConfig {
                conn: Arc::new(sock),
                relay_addr_generator: Box::new(RelayAddressGeneratorRanges {
                    relay_address: relay_ip,
                    min_port: cfg.relay_port_min,
                    max_port: cfg.relay_port_max,
                    max_retries: 20,
                    address: bind.to_string(),
                    net: Arc::new(webrtc_util::vnet::net::Net::new(None)),
                }),
            }],
            realm: "nexustalk".into(),
            auth_handler: Arc::new(turn::auth::LongTermAuthHandler::new(turn_secret.to_string())),
            channel_bind_timeout: std::time::Duration::from_secs(0),
            alloc_close_notify: None,
        })
        .await
        .map_err(|e| std::io::Error::other(format!("TURN-Server konnte nicht starten: {e}")))?;
        tracing::info!(port = cfg.udp_port, %relay_ip, "TURN relay listening (UDP)");
        return Ok(Some(MediaService::Turn(server)));
    }
    tracing::info!(port = cfg.udp_port, "STUN responder listening (UDP)");
    let handle = tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        loop {
            match sock.recv_from(&mut buf).await {
                Ok((n, from)) => {
                    if let Some(resp) = stun_binding_response(&buf[..n], from) {
                        let _ = sock.send_to(&resp, from).await;
                    }
                }
                // Windows reports ICMP "port unreachable" as a recv error; keep going.
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
            }
        }
    });
    Ok(Some(MediaService::Stun(handle)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Vec<u8> {
        let mut r = vec![0x00, 0x01, 0x00, 0x00];
        r.extend_from_slice(&MAGIC.to_be_bytes());
        r.extend_from_slice(&[7u8; 12]);
        r
    }

    #[test]
    fn answers_ipv4_binding() {
        let from: SocketAddr = "203.0.113.5:40000".parse().unwrap();
        let resp = stun_binding_response(&request(), from).unwrap();
        assert_eq!(&resp[0..2], &[0x01, 0x01]);
        assert_eq!(&resp[8..20], &[7u8; 12]);
        let xport = u16::from_be_bytes([resp[26], resp[27]]) ^ 0x2112;
        assert_eq!(xport, 40000);
        let xip = u32::from_be_bytes([resp[28], resp[29], resp[30], resp[31]]) ^ MAGIC;
        assert_eq!(std::net::Ipv4Addr::from(xip), "203.0.113.5".parse::<std::net::Ipv4Addr>().unwrap());
    }

    #[test]
    fn ignores_garbage() {
        let from: SocketAddr = "127.0.0.1:1".parse().unwrap();
        assert!(stun_binding_response(b"hello", from).is_none());
        let mut r = request();
        r[4] = 0;
        assert!(stun_binding_response(&r, from).is_none());
    }

    #[tokio::test]
    async fn stun_roundtrip_over_udp() {
        let cfg = MediaConfig { udp_port: 0, ..Default::default() };
        // Port 0 is rejected by config validation but fine for this direct call.
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = sock.local_addr().unwrap();
        drop(sock);
        let cfg = MediaConfig { udp_port: addr.port(), ..cfg };
        let svc = start(&cfg, "127.0.0.1".parse().unwrap(), "s").await.unwrap().unwrap();
        let client = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        client.send_to(&request(), addr).await.unwrap();
        let mut buf = [0u8; 100];
        let (n, _) = tokio::time::timeout(std::time::Duration::from_secs(2), client.recv_from(&mut buf))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(n, 32);
        svc.stop().await;
    }
}

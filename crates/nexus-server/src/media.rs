//! NAT traversal helpers on a UDP port: a minimal STUN binding responder
//! (RFC 5389) or, when enabled, a full TURN relay (webrtc-rs `turn` crate).
//! The TURN relay also accepts TCP on the same port number (RFC 5766 §2.1),
//! so it can be reached through a TCP tunnel when UDP is not (CGNAT).
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
    Turn(turn::server::Server, Option<tokio::task::JoinHandle<()>>),
}

impl MediaService {
    pub async fn stop(self) {
        match self {
            MediaService::Stun(h) => h.abort(),
            MediaService::Turn(s, tcp) => {
                if let Some(t) = tcp {
                    t.abort();
                }
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
        let relay_ip = if cfg.relay_ip.is_empty() {
            if bind.is_unspecified() { primary_local_ip().unwrap_or(bind) } else { bind }
        } else {
            cfg.relay_ip.parse().map_err(|_| std::io::Error::other("relay_ip ungültig"))?
        };
        let relay = TurnRelay { relay_ip, bind, min_port: cfg.relay_port_min, max_port: cfg.relay_port_max, secret: turn_secret.to_string() };
        let server = relay
            .server(Arc::new(sock))
            .await
            .map_err(|e| std::io::Error::other(format!("TURN-Server konnte nicht starten: {e}")))?;
        let tcp = match tokio::net::TcpListener::bind(SocketAddr::new(bind, cfg.udp_port)).await {
            Ok(l) => Some(tokio::spawn(relay.serve_tcp(l))),
            Err(e) => {
                tracing::warn!(error = %e, port = cfg.udp_port, "TURN über TCP nicht verfügbar");
                None
            }
        };
        tracing::info!(port = cfg.udp_port, %relay_ip, tcp = tcp.is_some(), "TURN relay listening (UDP + TCP)");
        return Ok(Some(MediaService::Turn(server, tcp)));
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

/// Settings shared by the UDP relay and every TCP relay connection.
#[derive(Clone)]
struct TurnRelay {
    relay_ip: IpAddr,
    bind: IpAddr,
    min_port: u16,
    max_port: u16,
    secret: String,
}

/// Concurrent TURN-over-TCP connections (each holds a few relay ports).
const MAX_TCP_CLIENTS: usize = 64;

impl TurnRelay {
    async fn server(&self, conn: Arc<dyn webrtc_util::Conn + Send + Sync>) -> Result<turn::server::Server, turn::Error> {
        use turn::relay::relay_range::RelayAddressGeneratorRanges;
        use turn::server::config::{ConnConfig, ServerConfig};
        turn::server::Server::new(ServerConfig {
            conn_configs: vec![ConnConfig {
                conn,
                relay_addr_generator: Box::new(RelayAddressGeneratorRanges {
                    relay_address: self.relay_ip,
                    min_port: self.min_port,
                    max_port: self.max_port,
                    max_retries: 20,
                    address: self.bind.to_string(),
                    net: Arc::new(webrtc_util::vnet::net::Net::new(None)),
                }),
            }],
            realm: "nexustalk".into(),
            auth_handler: Arc::new(turn::auth::LongTermAuthHandler::new(self.secret.clone())),
            channel_bind_timeout: std::time::Duration::from_secs(0),
            alloc_close_notify: None,
        })
        .await
    }

    /// Each TCP connection gets its own TURN server instance on a framed
    /// stream; its allocations are released when the connection closes.
    async fn serve_tcp(self, listener: tokio::net::TcpListener) {
        let slots = Arc::new(tokio::sync::Semaphore::new(MAX_TCP_CLIENTS));
        loop {
            let Ok((stream, remote)) = listener.accept().await else {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            };
            let Ok(permit) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let relay = self.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = stream.set_nodelay(true);
                let Ok(local) = stream.local_addr() else { return };
                let conn = Arc::new(TcpTurnConn::new(stream, local, remote));
                match relay.server(conn.clone()).await {
                    Ok(server) => {
                        conn.closed.notified().await;
                        let _ = server.close().await;
                    }
                    Err(e) => tracing::warn!(error = %e, "TURN über TCP: Verbindung abgelehnt"),
                }
            });
        }
    }
}

/// A TCP stream as a message-oriented [`webrtc_util::Conn`]: STUN messages
/// and ChannelData frames are split by their length headers.
pub struct TcpTurnConn {
    reader: tokio::sync::Mutex<tokio::net::tcp::OwnedReadHalf>,
    writer: tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>,
    local: SocketAddr,
    remote: SocketAddr,
    closed: tokio::sync::Notify,
}

impl TcpTurnConn {
    pub fn new(stream: tokio::net::TcpStream, local: SocketAddr, remote: SocketAddr) -> Self {
        let (r, w) = stream.into_split();
        Self { reader: tokio::sync::Mutex::new(r), writer: tokio::sync::Mutex::new(w), local, remote, closed: tokio::sync::Notify::new() }
    }
}

/// Length of the next frame from its 4-byte head: (message length, bytes on the wire).
fn tcp_frame_len(head: [u8; 4]) -> Option<(usize, usize)> {
    let len = u16::from_be_bytes([head[2], head[3]]) as usize;
    match head[0] {
        0x00..=0x3F => Some((20 + len, 20 + len)),
        // ChannelData is padded to a multiple of 4 on stream transports.
        0x40..=0x7F => Some((4 + len, (4 + len + 3) & !3)),
        _ => None,
    }
}

#[async_trait::async_trait]
impl webrtc_util::Conn for TcpTurnConn {
    async fn connect(&self, _addr: SocketAddr) -> webrtc_util::Result<()> {
        Err(webrtc_util::Error::Other("not supported".into()))
    }
    async fn recv(&self, buf: &mut [u8]) -> webrtc_util::Result<usize> {
        self.recv_from(buf).await.map(|(n, _)| n)
    }
    async fn recv_from(&self, buf: &mut [u8]) -> webrtc_util::Result<(usize, SocketAddr)> {
        use tokio::io::AsyncReadExt;
        let mut r = self.reader.lock().await;
        let mut head = [0u8; 4];
        r.read_exact(&mut head).await?;
        let (len, wire) = tcp_frame_len(head).ok_or_else(|| webrtc_util::Error::Other("invalid TURN frame".into()))?;
        if wire > buf.len() {
            return Err(webrtc_util::Error::Other("TURN frame too large".into()));
        }
        buf[..4].copy_from_slice(&head);
        r.read_exact(&mut buf[4..wire]).await?;
        Ok((len, self.remote))
    }
    async fn send(&self, buf: &[u8]) -> webrtc_util::Result<usize> {
        self.send_to(buf, self.remote).await
    }
    async fn send_to(&self, buf: &[u8], _target: SocketAddr) -> webrtc_util::Result<usize> {
        use tokio::io::AsyncWriteExt;
        self.writer.lock().await.write_all(buf).await?;
        Ok(buf.len())
    }
    fn local_addr(&self) -> webrtc_util::Result<SocketAddr> {
        Ok(self.local)
    }
    fn remote_addr(&self) -> Option<SocketAddr> {
        Some(self.remote)
    }
    async fn close(&self) -> webrtc_util::Result<()> {
        use tokio::io::AsyncWriteExt;
        let _ = self.writer.lock().await.shutdown().await;
        self.closed.notify_one();
        Ok(())
    }
    fn as_any(&self) -> &(dyn std::any::Any + Send + Sync) {
        self
    }
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

    #[test]
    fn tcp_frames_are_split_by_length() {
        assert_eq!(tcp_frame_len([0x00, 0x01, 0x00, 0x08]), Some((28, 28)));
        assert_eq!(tcp_frame_len([0x40, 0x00, 0x00, 0x05]), Some((9, 12)));
        assert_eq!(tcp_frame_len([0x40, 0x00, 0x00, 0x04]), Some((8, 8)));
        assert_eq!(tcp_frame_len([0xFF, 0, 0, 0]), None);
    }

    /// Full TURN allocation over TCP with the webrtc-rs client.
    #[tokio::test]
    async fn turn_allocates_over_tcp() {
        let sock = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let port = sock.local_addr().unwrap().port();
        drop(sock);
        let cfg = MediaConfig { udp_port: port, turn_enabled: true, relay_ip: "127.0.0.1".into(), relay_port_min: 49900, relay_port_max: 49950, ..Default::default() };
        let svc = start(&cfg, "127.0.0.1".parse().unwrap(), "secret").await.unwrap().unwrap();
        assert!(matches!(svc, MediaService::Turn(_, Some(_))), "TCP listener runs");
        let (user, pass) = crate::auth::turn_credentials("secret", 600).unwrap();
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let local = stream.local_addr().unwrap();
        let remote = stream.peer_addr().unwrap();
        let conn = Arc::new(TcpTurnConn::new(stream, local, remote));
        let client = turn::client::Client::new(turn::client::ClientConfig {
            stun_serv_addr: format!("127.0.0.1:{port}"),
            turn_serv_addr: format!("127.0.0.1:{port}"),
            username: user,
            password: pass,
            realm: "nexustalk".into(),
            software: String::new(),
            rto_in_ms: 0,
            conn,
            vnet: None,
        })
        .await
        .unwrap();
        client.listen().await.unwrap();
        let relayed = tokio::time::timeout(std::time::Duration::from_secs(5), client.allocate()).await.unwrap().unwrap();
        let addr = webrtc_util::Conn::local_addr(&relayed).unwrap();
        assert_eq!(addr.ip().to_string(), "127.0.0.1");
        assert!((49900..=49950).contains(&addr.port()), "relay port from the range: {addr}");
        client.close().await.unwrap();
        svc.stop().await;
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

//! Registry of live WebSocket connections, fan-out of events and presence.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use serde::Serialize;
use tokio::sync::{mpsc, Notify};

/// Outgoing frame for a connection's writer task.
#[derive(Debug, Clone)]
pub enum Out {
    Text(Arc<str>),
    Close(u16, &'static str),
}

pub const OUTBOX: usize = 512;

pub struct Conn {
    pub user_id: i64,
    pub ip: IpAddr,
    pub tx: mpsc::Sender<Out>,
    /// Signalled to force the connection's reader loop to stop.
    pub kill: Arc<Notify>,
}

#[derive(Default)]
struct Inner {
    conns: HashMap<u64, Conn>,
    by_user: HashMap<i64, Vec<u64>>,
    per_ip: HashMap<IpAddr, usize>,
    /// Presence chosen by the user (online / idle / dnd / invisible).
    presence: HashMap<i64, String>,
}

#[derive(Default)]
pub struct Hub {
    inner: RwLock<Inner>,
    next_id: AtomicU64,
}

pub fn event<T: Serialize>(name: &str, data: &T) -> Arc<str> {
    #[derive(Serialize)]
    struct Ev<'a, T> {
        ev: &'a str,
        d: &'a T,
    }
    serde_json::to_string(&Ev { ev: name, d: data }).unwrap_or_default().into()
}

impl Hub {
    fn read(&self) -> std::sync::RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(|p| p.into_inner())
    }
    fn write(&self) -> std::sync::RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(|p| p.into_inner())
    }

    pub fn total(&self) -> usize {
        self.read().conns.len()
    }

    pub fn ip_count(&self, ip: IpAddr) -> usize {
        self.read().per_ip.get(&ip).copied().unwrap_or(0)
    }

    /// Registers a connection. Returns its id and whether it is the user's first.
    pub fn register(&self, user_id: i64, ip: IpAddr, tx: mpsc::Sender<Out>, kill: Arc<Notify>, presence: &str) -> (u64, bool) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut g = self.write();
        g.conns.insert(id, Conn { user_id, ip, tx, kill });
        let list = g.by_user.entry(user_id).or_default();
        list.push(id);
        let first = list.len() == 1;
        *g.per_ip.entry(ip).or_default() += 1;
        if first {
            g.presence.insert(user_id, presence.to_string());
        }
        (id, first)
    }

    /// Removes a connection. Returns `(user_id, was_last_connection_of_user)`.
    pub fn unregister(&self, id: u64) -> Option<(i64, bool)> {
        let mut g = self.write();
        let c = g.conns.remove(&id)?;
        if let Some(n) = g.per_ip.get_mut(&c.ip) {
            *n -= 1;
            if *n == 0 {
                g.per_ip.remove(&c.ip);
            }
        }
        let mut last = false;
        if let Some(list) = g.by_user.get_mut(&c.user_id) {
            list.retain(|x| *x != id);
            if list.is_empty() {
                g.by_user.remove(&c.user_id);
                g.presence.remove(&c.user_id);
                last = true;
            }
        }
        Some((c.user_id, last))
    }

    fn deliver(c: &Conn, msg: &Arc<str>) {
        if let Err(mpsc::error::TrySendError::Full(_)) = c.tx.try_send(Out::Text(msg.clone())) {
            // A client that cannot keep up must not grow server memory unbounded.
            tracing::warn!(user = c.user_id, "connection outbox full, disconnecting slow client");
            c.kill.notify_one();
        }
    }

    pub fn send_conn(&self, id: u64, msg: &Arc<str>) {
        if let Some(c) = self.read().conns.get(&id) {
            Self::deliver(c, msg);
        }
    }

    pub fn send_user(&self, user_id: i64, msg: &Arc<str>) {
        let g = self.read();
        for id in g.by_user.get(&user_id).into_iter().flatten() {
            if let Some(c) = g.conns.get(id) {
                Self::deliver(c, msg);
            }
        }
    }

    /// Sends to every connection of a user except `skip`.
    pub fn send_user_except(&self, user_id: i64, skip: u64, msg: &Arc<str>) {
        let g = self.read();
        for id in g.by_user.get(&user_id).into_iter().flatten().filter(|i| **i != skip) {
            if let Some(c) = g.conns.get(id) {
                Self::deliver(c, msg);
            }
        }
    }

    pub fn broadcast(&self, msg: &Arc<str>, filter: impl Fn(i64) -> bool) {
        let g = self.read();
        for (uid, ids) in g.by_user.iter() {
            if !filter(*uid) {
                continue;
            }
            for id in ids {
                if let Some(c) = g.conns.get(id) {
                    Self::deliver(c, msg);
                }
            }
        }
    }

    pub fn online_users(&self) -> Vec<i64> {
        self.read().by_user.keys().copied().collect()
    }

    pub fn is_online(&self, user_id: i64) -> bool {
        self.read().by_user.contains_key(&user_id)
    }

    /// Presence as other users see it; invisible users appear offline.
    pub fn public_presence(&self, user_id: i64) -> &'static str {
        match self.read().presence.get(&user_id).map(|s| s.as_str()) {
            None | Some("invisible") => "offline",
            Some("idle") => "idle",
            Some("dnd") => "dnd",
            Some(_) => "online",
        }
    }

    pub fn set_presence(&self, user_id: i64, p: &str) {
        let mut g = self.write();
        if g.by_user.contains_key(&user_id) {
            g.presence.insert(user_id, p.to_string());
        }
    }

    /// Closes all connections of a user (ban, password change, deletion).
    pub fn disconnect_user(&self, user_id: i64, code: u16, reason: &'static str) {
        let g = self.read();
        for id in g.by_user.get(&user_id).into_iter().flatten() {
            if let Some(c) = g.conns.get(id) {
                let _ = c.tx.try_send(Out::Close(code, reason));
                c.kill.notify_one();
            }
        }
    }

    pub fn disconnect_all(&self, code: u16, reason: &'static str) {
        let g = self.read();
        for c in g.conns.values() {
            let _ = c.tx.try_send(Out::Close(code, reason));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_and_presence() {
        let hub = Hub::default();
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        let (tx1, mut rx1) = mpsc::channel(4);
        let (tx2, _rx2) = mpsc::channel(4);
        let (a, first) = hub.register(1, ip, tx1, Arc::new(Notify::new()), "invisible");
        assert!(first);
        let (b, first) = hub.register(1, ip, tx2, Arc::new(Notify::new()), "online");
        assert!(!first);
        assert_eq!(hub.ip_count(ip), 2);
        assert_eq!(hub.public_presence(1), "offline", "invisible looks offline");
        hub.set_presence(1, "dnd");
        assert_eq!(hub.public_presence(1), "dnd");
        hub.send_user_except(1, b, &"x".into());
        assert!(matches!(rx1.try_recv(), Ok(Out::Text(_))));
        assert_eq!(hub.unregister(a), Some((1, false)));
        assert_eq!(hub.unregister(b), Some((1, true)));
        assert_eq!(hub.public_presence(1), "offline");
        assert_eq!(hub.ip_count(ip), 0);
    }

    #[test]
    fn slow_client_is_killed() {
        let hub = Hub::default();
        let (tx, _rx) = mpsc::channel(1);
        let kill = Arc::new(Notify::new());
        hub.register(1, "127.0.0.1".parse().unwrap(), tx, kill.clone(), "online");
        let msg: Arc<str> = "m".into();
        hub.send_user(1, &msg);
        hub.send_user(1, &msg);
        // notify_one stores a permit, so this resolves immediately.
        let rt = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        rt.block_on(async {
            tokio::time::timeout(std::time::Duration::from_millis(100), kill.notified()).await.expect("kill signalled");
        });
    }
}

//! "Servermodus": runs one or more Domus servers inside the desktop app.
//!
//! Every hosted server has its own data folder, configuration and ports. A
//! small registry (`hosts.json`) lists them. Per server, a supervisor task
//! owns the running instance, restarts it when an admin asks for it (e.g.
//! after a backup restore) and stops it on request. Servers keep running
//! while the window is hidden in the tray.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use nexus_server::config::Config;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::oneshot;

use crate::reach::{self, UpnpStatus};
use crate::tunnel::{self, RelayStatus};

/// Id of the server that lives in the legacy `server` folder (version 0.1/0.2).
pub const MAIN_ID: &str = "main";

const BASE_TCP: u16 = 7878;
const BASE_UDP: u16 = 3478;
const BASE_RELAY: u16 = 49160;
const RELAY_STRIDE: u16 = 50;
const RELAY_SPAN: u16 = 40;

#[derive(Debug, Clone, Default, Serialize)]
pub struct HostStatus {
    pub id: String,
    pub name: String,
    pub autostart: bool,
    pub running: bool,
    pub address: Option<String>,
    pub fingerprint: Option<String>,
    pub setup_code: Option<String>,
    pub error: Option<String>,
    pub data_dir: String,
    pub exposed: bool,
    pub lan_ip: Option<String>,
    /// From the saved configuration, also while stopped.
    pub port: u16,
    pub udp_port: u16,
    pub tls: bool,
    pub public_host: String,
    /// Router port forwarding (only while running and reachable from the network).
    pub upnp: Option<UpnpStatus>,
    /// Internet relay: on/off and – while running – the public address.
    pub relay_enabled: bool,
    pub relay: Option<RelayStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostEntry {
    pub id: String,
    pub name: String,
    /// Folder name below the app data directory.
    pub dir: String,
    #[serde(default)]
    pub autostart: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Registry {
    hosts: Vec<HostEntry>,
    /// One-time upgrades already applied to this file.
    #[serde(default)]
    rev: u32,
}

#[derive(Default)]
struct Live {
    running: bool,
    address: Option<String>,
    fingerprint: Option<String>,
    setup_code: Option<String>,
    error: Option<String>,
    exposed: bool,
    upnp: Option<UpnpStatus>,
}

/// Forwarded ports of a running server: TCP plus the STUN/TURN UDP port.
fn upnp_ports(cfg: &Config) -> (u16, Option<u16>) {
    (cfg.port, (cfg.media.stun_enabled || cfg.media.turn_enabled).then_some(cfg.media.udp_port))
}

/// Asks the router to forward the ports and renews the lease until aborted.
fn spawn_upnp(live: Arc<Mutex<Live>>, cfg: &Config) -> tauri::async_runtime::JoinHandle<()> {
    let (port, udp) = upnp_ports(cfg);
    tauri::async_runtime::spawn(async move {
        loop {
            let st = match nexus_server::media::primary_local_ip() {
                Some(IpAddr::V4(v4)) => reach::upnp_map(v4, port, udp).await,
                _ => UpnpStatus { error: Some("Keine lokale IPv4-Adresse".into()), ..Default::default() },
            };
            if st.mapped {
                tracing::info!(port, external = ?st.external_ip, cgnat = st.cgnat, "Router-Weiterleitung per UPnP eingerichtet");
            } else {
                tracing::warn!(port, error = ?st.error, "Router-Weiterleitung per UPnP nicht möglich");
            }
            lock(&live).upnp = Some(st);
            tokio::time::sleep(reach::RENEW_EVERY).await;
        }
    })
}

/// One embedded server.
pub struct HostInstance {
    pub id: String,
    pub data_dir: PathBuf,
    live: Arc<Mutex<Live>>,
    relay: Arc<Mutex<Option<RelayStatus>>>,
    control: tokio::sync::Mutex<Option<(oneshot::Sender<()>, tauri::async_runtime::JoinHandle<()>)>>,
}

impl HostInstance {
    fn new(id: String, data_dir: PathBuf) -> Self {
        Self { id, data_dir, live: Arc::default(), relay: Arc::default(), control: tokio::sync::Mutex::new(None) }
    }

    fn config_path(&self) -> PathBuf {
        self.data_dir.join("server.toml")
    }

    pub fn load_config(&self) -> Result<Config, String> {
        Config::load(&self.config_path()).map_err(|e| e.to_string())
    }

    pub fn save_config(&self, cfg: &Config) -> Result<(), String> {
        std::fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        cfg.save(&self.config_path()).map_err(|e| e.to_string())
    }

    pub fn is_running(&self) -> bool {
        lock(&self.live).running
    }

    fn status(&self, entry: &HostEntry) -> HostStatus {
        let live = lock(&self.live);
        let cfg = self.load_config().ok();
        HostStatus {
            id: self.id.clone(),
            name: entry.name.clone(),
            autostart: entry.autostart,
            running: live.running,
            address: live.address.clone(),
            fingerprint: live.fingerprint.clone(),
            setup_code: live.setup_code.clone(),
            error: live.error.clone(),
            data_dir: self.data_dir.display().to_string(),
            exposed: if live.running { live.exposed } else { cfg.as_ref().is_some_and(|c| c.is_exposed()) },
            lan_ip: nexus_server::media::primary_local_ip().map(|i| i.to_string()),
            port: cfg.as_ref().map(|c| c.port).unwrap_or_default(),
            udp_port: cfg.as_ref().map(|c| c.media.udp_port).unwrap_or_default(),
            tls: cfg.as_ref().is_some_and(|c| c.tls.enabled),
            public_host: cfg.map(|c| c.public_host).unwrap_or_default(),
            upnp: if live.running { live.upnp.clone() } else { None },
            relay_enabled: tunnel::load(&self.data_dir).enabled,
            relay: if live.running { lock(&self.relay).clone() } else { None },
        }
    }

    pub async fn start(&self) -> Result<(), String> {
        let mut ctl = self.control.lock().await;
        if ctl.is_some() && self.is_running() {
            return Ok(());
        }
        std::fs::create_dir_all(&self.data_dir).map_err(|e| e.to_string())?;
        let cfg = self.load_config()?;
        if !self.config_path().exists() {
            self.save_config(&cfg)?;
        }
        let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
        let (first_tx, first_rx) = oneshot::channel::<Result<(), String>>();
        let live = self.live.clone();
        let relay_state = self.relay.clone();
        let data_dir = self.data_dir.clone();
        let cfg_path = self.config_path();
        let id = self.id.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let mut first = Some(first_tx);
            let mut cfg = cfg;
            loop {
                // With the internet tunnel, voice/video also needs a relay that is
                // reachable through it: TURN (UDP locally, TCP through the tunnel).
                let tunnel_on = cfg.is_exposed() && tunnel::load(&data_dir).enabled;
                let mut run = cfg.clone();
                if tunnel_on {
                    run.media.turn_enabled = true;
                }
                let server = match nexus_server::start(run, &data_dir).await {
                    Ok(s) => s,
                    Err(e) => {
                        let msg = e.to_string();
                        tracing::error!(host = %id, "Server konnte nicht gestartet werden: {msg}");
                        {
                            let mut st = lock(&live);
                            st.running = false;
                            st.error = Some(msg.clone());
                        }
                        if let Some(f) = first.take() {
                            let _ = f.send(Err(msg));
                        }
                        return;
                    }
                };
                {
                    let mut st = lock(&live);
                    st.running = true;
                    st.error = None;
                    st.address = Some(server.local_addr.to_string());
                    st.fingerprint = server.tls_fingerprint.clone();
                    st.setup_code = server.setup_code.clone();
                    st.exposed = cfg.is_exposed();
                    st.upnp = None;
                }
                if let Some(f) = first.take() {
                    let _ = f.send(Ok(()));
                }
                // Reachable from the network: open the router ports as well.
                let upnp = cfg.is_exposed().then(|| spawn_upnp(live.clone(), &cfg));
                // Internet relay for connections without port forwarding (CGNAT).
                let relay = tunnel_on.then(|| {
                    let state = server.state.clone();
                    [
                        tunnel::spawn(relay_state.clone(), data_dir.clone(), cfg.port, tunnel::Slot::Server, |_| {}),
                        tunnel::spawn(relay_state.clone(), data_dir.clone(), cfg.media.udp_port, tunnel::Slot::Turn, move |addr| {
                            *state.turn_public.write().unwrap_or_else(|e| e.into_inner()) = addr;
                        }),
                    ]
                });
                let stop = tokio::select! {
                    _ = &mut stop_rx => true,
                    _ = server.restart_requested() => false,
                };
                if let Some(tasks) = relay {
                    tasks.iter().for_each(|t| t.abort());
                    *lock(&relay_state) = None;
                }
                if let Some(task) = upnp {
                    task.abort();
                    let (port, udp) = upnp_ports(&cfg);
                    if lock(&live).upnp.as_ref().is_some_and(|u| u.mapped) {
                        reach::upnp_unmap(port, udp).await;
                    }
                    lock(&live).upnp = None;
                }
                server.shutdown().await;
                if stop {
                    let mut st = lock(&live);
                    st.running = false;
                    st.address = None;
                    st.setup_code = None;
                    return;
                }
                // Restart: re-read the configuration in case it was changed.
                if let Ok(c) = Config::load(&cfg_path) {
                    cfg = c;
                }
            }
        });
        match first_rx.await {
            Ok(Ok(())) => {
                *ctl = Some((stop_tx, handle));
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(_) => Err("Server-Task wurde unerwartet beendet".into()),
        }
    }

    pub async fn stop(&self) {
        let mut ctl = self.control.lock().await;
        if let Some((tx, handle)) = ctl.take() {
            let _ = tx.send(());
            let _ = handle.await;
        }
        let mut st = lock(&self.live);
        st.running = false;
        st.address = None;
    }

    /// The setup code disappears from the UI once the owner exists.
    fn clear_setup_code(&self) {
        lock(&self.live).setup_code = None;
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// All hosted servers of this app.
pub struct HostManager {
    base: PathBuf,
    registry: Mutex<Registry>,
    instances: Mutex<Vec<Arc<HostInstance>>>,
}

impl HostManager {
    /// Loads `hosts.json`. Without it, an existing legacy `server` folder is
    /// imported as the first server (autostart taken over from the old setting).
    pub fn load(base: PathBuf, legacy_autostart: bool) -> Self {
        let path = base.join("hosts.json");
        let mut reg: Registry = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        let fresh = !path.exists();
        if fresh {
            let legacy = base.join("server");
            if legacy.join("server.toml").exists() || legacy.join("nexus.db").exists() {
                reg.hosts.push(HostEntry { id: MAIN_ID.into(), name: String::new(), dir: "server".into(), autostart: legacy_autostart });
            }
        }
        // 0.10: every server starts together with the app by default (one global
        // switch in the settings turns that off; the per-server switch remains).
        let upgraded = reg.rev < 1;
        if upgraded {
            reg.hosts.iter_mut().for_each(|h| h.autostart = true);
            reg.rev = 1;
        }
        let instances = reg.hosts.iter().map(|h| Arc::new(HostInstance::new(h.id.clone(), base.join(&h.dir)))).collect();
        let mgr = Self { base, registry: Mutex::new(reg), instances: Mutex::new(instances) };
        if fresh || upgraded {
            let _ = mgr.save_registry();
        }
        mgr
    }

    fn save_registry(&self) -> Result<(), String> {
        let reg = lock(&self.registry).clone();
        let data = serde_json::to_vec_pretty(&reg).map_err(|e| e.to_string())?;
        let path = self.base.join("hosts.json");
        let tmp = path.with_extension("json.tmp");
        std::fs::create_dir_all(&self.base).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
    }

    pub fn get(&self, id: &str) -> Result<Arc<HostInstance>, String> {
        lock(&self.instances).iter().find(|i| i.id == id).cloned().ok_or_else(|| "Server nicht gefunden".into())
    }

    fn entry(&self, id: &str) -> Result<HostEntry, String> {
        lock(&self.registry).hosts.iter().find(|h| h.id == id).cloned().ok_or_else(|| "Server nicht gefunden".into())
    }

    pub fn status(&self, id: &str) -> Result<HostStatus, String> {
        Ok(self.get(id)?.status(&self.entry(id)?))
    }

    pub fn list(&self) -> Vec<HostStatus> {
        let reg = lock(&self.registry).clone();
        reg.hosts.iter().filter_map(|e| self.get(&e.id).ok().map(|i| i.status(e))).collect()
    }

    pub fn any_running(&self) -> bool {
        lock(&self.instances).iter().any(|i| i.is_running())
    }

    pub fn autostart_ids(&self) -> Vec<String> {
        lock(&self.registry).hosts.iter().filter(|h| h.autostart).map(|h| h.id.clone()).collect()
    }

    pub async fn stop_all(&self) {
        let all: Vec<_> = lock(&self.instances).clone();
        for i in all {
            i.stop().await;
        }
    }

    fn update_entry(&self, id: &str, f: impl FnOnce(&mut HostEntry)) -> Result<(), String> {
        {
            let mut reg = lock(&self.registry);
            let e = reg.hosts.iter_mut().find(|h| h.id == id).ok_or("Server nicht gefunden")?;
            f(e);
        }
        self.save_registry()
    }

    /// Ports already claimed by other hosted servers (running or not).
    fn used_ports(&self, except: Option<&str>) -> (Vec<u16>, Vec<u16>) {
        let mut tcp = Vec::new();
        let mut udp = Vec::new();
        for i in lock(&self.instances).iter().filter(|i| Some(i.id.as_str()) != except) {
            if let Ok(c) = i.load_config() {
                tcp.push(c.port);
                udp.push(c.media.udp_port);
            }
        }
        (tcp, udp)
    }

    /// Creates a new server with ready-to-use defaults: free ports, TLS,
    /// STUN, invite-only registration, and – on request – LAN reachability.
    pub fn create(&self, name: String, exposed: bool) -> Result<HostStatus, String> {
        let bind = if exposed { IpAddr::V4(Ipv4Addr::UNSPECIFIED) } else { IpAddr::V4(Ipv4Addr::LOCALHOST) };
        let slot = self.free_slot(None, bind)?;
        let id = if lock(&self.registry).hosts.is_empty() && !self.base.join("server").exists() {
            MAIN_ID.to_string()
        } else {
            new_id()
        };
        let dir = if id == MAIN_ID { "server".to_string() } else { format!("servers/{id}") };
        let mut cfg = Config { bind: bind.to_string(), ..Default::default() };
        apply_slot(&mut cfg, slot);
        if exposed {
            cfg.public_host = nexus_server::media::primary_local_ip().map(|i| i.to_string()).unwrap_or_default();
        }
        let inst = Arc::new(HostInstance::new(id.clone(), self.base.join(&dir)));
        inst.save_config(&cfg)?;
        lock(&self.registry).hosts.push(HostEntry { id: id.clone(), name, dir, autostart: true });
        lock(&self.instances).push(inst);
        self.save_registry()?;
        self.status(&id)
    }

    /// Stops and forgets a server. With `delete_data`, its folder is removed.
    pub async fn remove(&self, id: &str, delete_data: bool) -> Result<(), String> {
        let inst = self.get(id)?;
        inst.stop().await;
        lock(&self.registry).hosts.retain(|h| h.id != id);
        lock(&self.instances).retain(|i| i.id != id);
        self.save_registry()?;
        if delete_data && inst.data_dir.starts_with(&self.base) && inst.data_dir != self.base {
            std::fs::remove_dir_all(&inst.data_dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// First port slot whose TCP/UDP ports are neither used by another hosted
    /// server nor by any other program.
    fn free_slot(&self, except: Option<&str>, bind: IpAddr) -> Result<u16, String> {
        let (used_tcp, used_udp) = self.used_ports(except);
        (0..200u16)
            .find(|n| {
                let (tcp, udp) = (BASE_TCP + n, BASE_UDP + n);
                !used_tcp.contains(&tcp) && !used_udp.contains(&udp) && tcp_free(bind, tcp) && udp_free(bind, udp)
            })
            .ok_or_else(|| "Keine freien Ports gefunden".into())
    }

    /// Checks a configuration change for port conflicts with the other servers.
    fn check_ports(&self, id: &str, cfg: &Config) -> Result<(), String> {
        let (tcp, udp) = self.used_ports(Some(id));
        if tcp.contains(&cfg.port) {
            return Err(format!("TCP-Port {} wird bereits von einem anderen deiner Server verwendet", cfg.port));
        }
        if (cfg.media.stun_enabled || cfg.media.turn_enabled) && udp.contains(&cfg.media.udp_port) {
            return Err(format!("UDP-Port {} wird bereits von einem anderen deiner Server verwendet", cfg.media.udp_port));
        }
        Ok(())
    }
}

fn apply_slot(cfg: &mut Config, slot: u16) {
    cfg.port = BASE_TCP + slot;
    cfg.media.udp_port = BASE_UDP + slot;
    cfg.media.relay_port_min = BASE_RELAY + slot * RELAY_STRIDE;
    cfg.media.relay_port_max = cfg.media.relay_port_min + RELAY_SPAN;
}

/// Addresses a port must be free on: the chosen one plus all interfaces (IPv4
/// and IPv6), so a "this PC only" server can later be opened to the network
/// and does not clash with other programs listening everywhere.
fn probe_addrs(ip: IpAddr) -> [IpAddr; 3] {
    [ip, IpAddr::V4(Ipv4Addr::UNSPECIFIED), IpAddr::V6(std::net::Ipv6Addr::UNSPECIFIED)]
}

/// Only "address in use" counts as taken (no IPv6 on the machine is fine).
fn bind_ok<T>(r: std::io::Result<T>) -> bool {
    !matches!(r, Err(e) if e.kind() == std::io::ErrorKind::AddrInUse || e.kind() == std::io::ErrorKind::PermissionDenied)
}

fn tcp_free(ip: IpAddr, port: u16) -> bool {
    probe_addrs(ip).into_iter().all(|a| bind_ok(std::net::TcpListener::bind(SocketAddr::new(a, port))))
}

fn udp_free(ip: IpAddr, port: u16) -> bool {
    probe_addrs(ip).into_iter().all(|a| bind_ok(std::net::UdpSocket::bind(SocketAddr::new(a, port))))
}

fn new_id() -> String {
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or_default();
    format!("s{:x}", n & 0xffff_ffff_ffff)
}

// ------------------------------------------------------------------ commands

#[tauri::command]
pub fn host_list(hosts: State<'_, HostManager>) -> Vec<HostStatus> {
    hosts.list()
}

#[tauri::command]
pub fn host_status(hosts: State<'_, HostManager>, id: String) -> Result<HostStatus, String> {
    hosts.status(&id)
}

#[tauri::command]
pub async fn host_create(hosts: State<'_, HostManager>, name: String, exposed: bool) -> Result<HostStatus, String> {
    let name: String = name.trim().chars().take(64).collect();
    let st = hosts.create(name, exposed)?;
    hosts.get(&st.id)?.start().await?;
    hosts.status(&st.id)
}

#[tauri::command]
pub async fn host_remove(hosts: State<'_, HostManager>, id: String, delete_data: bool) -> Result<(), String> {
    hosts.remove(&id, delete_data).await
}

#[tauri::command]
pub fn host_rename(hosts: State<'_, HostManager>, id: String, name: String) -> Result<(), String> {
    let name: String = name.trim().chars().take(64).collect();
    hosts.update_entry(&id, |e| e.name = name)
}

#[tauri::command]
pub fn host_set_autostart(hosts: State<'_, HostManager>, id: String, autostart: bool) -> Result<(), String> {
    hosts.update_entry(&id, |e| e.autostart = autostart)
}

/// Turns the internet relay on or off; a running server picks it up on restart.
#[tauri::command]
pub async fn host_set_relay(hosts: State<'_, HostManager>, id: String, enabled: bool) -> Result<HostStatus, String> {
    let inst = hosts.get(&id)?;
    let mut s = tunnel::load(&inst.data_dir);
    s.enabled = enabled;
    tunnel::save(&inst.data_dir, &s);
    if inst.is_running() {
        inst.stop().await;
        inst.start().await?;
    }
    hosts.status(&id)
}

#[tauri::command]
pub fn host_config(hosts: State<'_, HostManager>, id: String) -> Result<Config, String> {
    hosts.get(&id)?.load_config()
}

#[tauri::command]
pub fn host_config_save(hosts: State<'_, HostManager>, id: String, config: Config) -> Result<(), String> {
    hosts.check_ports(&id, &config)?;
    hosts.get(&id)?.save_config(&config)
}

/// Replaces a damaged configuration file with defaults (keeps a copy).
#[tauri::command]
pub fn host_config_reset(hosts: State<'_, HostManager>, id: String) -> Result<(), String> {
    let inst = hosts.get(&id)?;
    let p = inst.config_path();
    if p.exists() {
        let _ = std::fs::rename(&p, p.with_extension("toml.broken"));
    }
    let mut cfg = Config::default();
    if hosts.check_ports(&id, &cfg).is_err() {
        let slot = hosts.free_slot(Some(&id), IpAddr::V4(Ipv4Addr::LOCALHOST))?;
        apply_slot(&mut cfg, slot);
    }
    inst.save_config(&cfg)
}

#[tauri::command]
pub async fn host_start(hosts: State<'_, HostManager>, id: String) -> Result<HostStatus, String> {
    hosts.get(&id)?.start().await?;
    hosts.status(&id)
}

#[tauri::command]
pub async fn host_stop(hosts: State<'_, HostManager>, id: String) -> Result<HostStatus, String> {
    hosts.get(&id)?.stop().await;
    hosts.status(&id)
}

#[tauri::command]
pub async fn host_restart(hosts: State<'_, HostManager>, id: String) -> Result<HostStatus, String> {
    let inst = hosts.get(&id)?;
    inst.stop().await;
    inst.start().await?;
    hosts.status(&id)
}

#[tauri::command]
pub fn host_setup_done(hosts: State<'_, HostManager>, id: String) -> Result<(), String> {
    hosts.get(&id)?.clear_setup_code();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nx-hosts-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn legacy_server_folder_is_imported_once() {
        let base = temp_base("legacy");
        std::fs::create_dir_all(base.join("server")).unwrap();
        Config::default().save(&base.join("server/server.toml")).unwrap();
        let m = HostManager::load(base.clone(), true);
        let list = m.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, MAIN_ID);
        assert!(list[0].autostart, "old autostart setting is taken over");
        assert!(base.join("hosts.json").exists());
        // A second load uses the registry and does not import again.
        assert_eq!(HostManager::load(base.clone(), false).list().len(), 1);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn new_servers_get_separate_ports_and_folders() {
        let base = temp_base("create");
        let m = HostManager::load(base.clone(), false);
        assert!(m.list().is_empty());
        let a = m.create("Alpha".into(), false).unwrap();
        let b = m.create("Beta".into(), true).unwrap();
        assert_eq!(a.id, MAIN_ID);
        assert_ne!(a.port, b.port);
        assert_ne!(a.udp_port, b.udp_port);
        assert_ne!(a.data_dir, b.data_dir);
        assert!(!a.exposed && b.exposed);
        let cb = m.get(&b.id).unwrap().load_config().unwrap();
        let ca = m.get(&a.id).unwrap().load_config().unwrap();
        let disjoint = ca.media.relay_port_max < cb.media.relay_port_min || cb.media.relay_port_max < ca.media.relay_port_min;
        assert!(disjoint, "relay ranges must not overlap");
        assert!(cb.validate().is_ok());
        // Registry survives a restart of the app.
        let again = HostManager::load(base.clone(), false);
        let names: Vec<_> = again.list().into_iter().map(|h| h.name).collect();
        assert_eq!(names, vec!["Alpha", "Beta"]);
        // Port conflicts between own servers are refused.
        let mut clash = cb.clone();
        clash.port = a.port;
        assert!(again.check_ports(&b.id, &clash).is_err());
        assert!(again.check_ports(&b.id, &cb).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn ports_taken_on_all_interfaces_are_skipped() {
        // Something listens on every interface (like another server program).
        let other = std::net::TcpListener::bind("0.0.0.0:0").unwrap();
        let port = other.local_addr().unwrap().port();
        assert!(!tcp_free(IpAddr::V4(Ipv4Addr::LOCALHOST), port), "loopback alone would look free on Windows");
        drop(other);
        assert!(tcp_free(IpAddr::V4(Ipv4Addr::LOCALHOST), port));
    }

    #[test]
    fn two_servers_run_at_the_same_time_and_can_be_removed() {
        let base = temp_base("run");
        let m = HostManager::load(base.clone(), false);
        let a = m.create("A".into(), false).unwrap();
        let b = m.create("B".into(), false).unwrap();
        tauri::async_runtime::block_on(async {
            m.get(&a.id).unwrap().start().await.unwrap();
            m.get(&b.id).unwrap().start().await.unwrap();
            let sa = m.status(&a.id).unwrap();
            let sb = m.status(&b.id).unwrap();
            assert!(sa.running && sb.running);
            assert!(sa.setup_code.is_some() && sb.setup_code.is_some(), "each server needs its own owner");
            assert_ne!(sa.address, sb.address);
            assert!(m.any_running());
            let b_dir = PathBuf::from(&sb.data_dir);
            m.remove(&b.id, true).await.unwrap();
            assert!(!b_dir.exists(), "data folder is deleted");
            assert_eq!(m.list().len(), 1);
            m.stop_all().await;
            assert!(!m.any_running());
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Voice relay through the internet tunnel: two TURN-over-TCP clients reach
    /// the embedded TURN server via bore.pub, allocate relay ports and exchange
    /// data through them (the path friends behind CGNAT take for voice).
    /// `cargo test -p nexustalk turn_through_relay -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn turn_through_relay() {
        use webrtc_util::Conn;
        let base = temp_base("turnrelay");
        let m = HostManager::load(base.clone(), false);
        let a = m.create("Turn".into(), false).unwrap();
        let inst = m.get(&a.id).unwrap();
        let mut cfg = Config::load(&inst.config_path()).unwrap();
        cfg.media.turn_enabled = true;
        cfg.media.relay_ip = "127.0.0.1".into();
        inst.save_config(&cfg).unwrap();
        tauri::async_runtime::block_on(async {
            inst.start().await.unwrap();
            let relay: Arc<Mutex<Option<RelayStatus>>> = Arc::default();
            let task = tunnel::spawn(relay.clone(), inst.data_dir.clone(), cfg.media.udp_port, tunnel::Slot::Turn, |_| {});
            let mut addr = None;
            for _ in 0..100 {
                addr = lock(&relay).as_ref().and_then(|r| r.turn_address.clone());
                if addr.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let addr = addr.expect("TURN tunnel address");
            println!("TURN through {addr}");
            // Credentials as the server hands them out (shared secret in the database).
            let secret: String = rusqlite::Connection::open(inst.data_dir.join("nexus.db"))
                .unwrap()
                .query_row("SELECT value FROM settings WHERE key='turn_secret'", [], |r| r.get(0))
                .unwrap();
            let creds = turn::auth::generate_long_term_credentials(&secret, std::time::Duration::from_secs(600)).unwrap();
            let mut relayed = Vec::new();
            let mut clients = Vec::new();
            for _ in 0..2 {
                let stream = tokio::net::TcpStream::connect(addr.as_str()).await.unwrap();
                let (local, remote) = (stream.local_addr().unwrap(), stream.peer_addr().unwrap());
                let conn = Arc::new(nexus_server::media::TcpTurnConn::new(stream, local, remote));
                let client = turn::client::Client::new(turn::client::ClientConfig {
                    stun_serv_addr: addr.clone(),
                    turn_serv_addr: addr.clone(),
                    username: creds.0.clone(),
                    password: creds.1.clone(),
                    realm: "nexustalk".into(),
                    software: String::new(),
                    rto_in_ms: 0,
                    conn,
                    vnet: None,
                })
                .await
                .unwrap();
                client.listen().await.unwrap();
                let r = tokio::time::timeout(std::time::Duration::from_secs(10), client.allocate()).await.expect("allocate in time").unwrap();
                println!("relayed address {}", r.local_addr().unwrap());
                relayed.push(r);
                clients.push(client);
            }
            let (ra, rb) = (relayed.remove(0), relayed.remove(0));
            let (addr_a, addr_b) = (ra.local_addr().unwrap(), rb.local_addr().unwrap());
            // Permissions are created by sending once in each direction.
            let _ = rb.send_to(b"hi", addr_a).await;
            ra.send_to(b"voice packet", addr_b).await.unwrap();
            let mut buf = [0u8; 64];
            let mut got = None;
            for _ in 0..5 {
                match tokio::time::timeout(std::time::Duration::from_secs(2), rb.recv_from(&mut buf)).await {
                    Ok(Ok((n, from))) if &buf[..n] == b"voice packet" => {
                        got = Some(from);
                        break;
                    }
                    _ => {
                        let _ = rb.send_to(b"hi", addr_a).await;
                        ra.send_to(b"voice packet", addr_b).await.unwrap();
                    }
                }
            }
            assert_eq!(got, Some(addr_a), "data arrived through both relays");
            for c in clients {
                let _ = c.close().await;
            }
            task.abort();
            m.stop_all().await;
        });
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Full internet path through the public relay: hosted server → bore.pub →
    /// pinned TLS client (HTTP + WebSocket).
    /// `cargo test -p nexustalk server_through_relay -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn server_through_relay() {
        let base = temp_base("relay");
        let m = HostManager::load(base.clone(), false);
        let a = m.create("Relay".into(), false).unwrap();
        tauri::async_runtime::block_on(async {
            m.get(&a.id).unwrap().start().await.unwrap();
            let st = m.status(&a.id).unwrap();
            let fp = st.fingerprint.clone().expect("TLS fingerprint");
            let relay: Arc<Mutex<Option<RelayStatus>>> = Arc::default();
            let task = tunnel::spawn(relay.clone(), PathBuf::from(&st.data_dir), st.port, tunnel::Slot::Server, |_| {});
            let mut addr = None;
            for _ in 0..100 {
                addr = lock(&relay).as_ref().and_then(|r| r.address.clone());
                if addr.is_some() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            }
            let addr = addr.expect("relay address");
            println!("public address {addr}");
            assert_eq!(tunnel::load(std::path::Path::new(&st.data_dir)).port, addr.rsplit(':').next().and_then(|p| p.parse().ok()), "port is remembered");
            let ep = nexus_net::Endpoint::new(&format!("https://{addr}"), Some(&fp)).unwrap();
            let r = ep.request("GET", "/api/v1/info", None, None, None).await.expect("info through relay");
            assert_eq!(r.status, 200);
            println!("info: {}", String::from_utf8_lossy(&r.body));
            ep.connect_ws().await.expect("websocket through relay");
            // A wrong pin must be refused even though the relay forwards everything.
            let bad = nexus_net::Endpoint::new(&format!("https://{addr}"), Some(&"AA".repeat(32))).unwrap();
            assert!(matches!(bad.request("GET", "/api/v1/info", None, None, None).await, Err(nexus_net::NetError::Mismatch { .. })));
            task.abort();
            m.stop_all().await;
        });
        let _ = std::fs::remove_dir_all(&base);
    }
}

//! Making hosted servers reachable for others:
//! * Windows Firewall – check whether inbound connections to NexusTalk are
//!   allowed, and add an allow rule after one administrator confirmation (UAC).
//! * Router – forward the server's ports automatically via UPnP and learn the
//!   public IP address for internet invite links.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use serde::Serialize;

// ------------------------------------------------------------------ firewall

#[derive(Debug, Clone, Default, Serialize)]
pub struct FirewallStatus {
    /// False outside Windows (nothing to configure).
    pub supported: bool,
    /// Enabled inbound allow rules for this program.
    pub allow: u32,
    /// Enabled inbound block rules for this program (created when someone
    /// dismissed the Windows firewall prompt) – these win over allow rules.
    pub block: u32,
    /// Network category of the active connection: "Public", "Private", "DomainAuthenticated".
    pub network: String,
    pub error: Option<String>,
}

fn exe_path() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

/// PowerShell string literal (single quotes, inner quotes doubled).
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Script that reports the rules for `exe` as compact JSON. Enum values come
/// back in English regardless of the Windows display language.
fn status_script(exe: &str) -> String {
    format!(
        "$p = {exe}; \
         $r = @(Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | \
           Where-Object {{ [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p }} | \
           Get-NetFirewallRule -ErrorAction SilentlyContinue | \
           Where-Object {{ $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' }}); \
         $n = @(Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1); \
         [pscustomobject]@{{ allow = @($r | Where-Object {{ $_.Action -eq 'Allow' }}).Count; \
           block = @($r | Where-Object {{ $_.Action -eq 'Block' }}).Count; \
           network = if ($n) {{ [string]$n[0].NetworkCategory }} else {{ '' }} }} | ConvertTo-Json -Compress",
        exe = ps_quote(exe)
    )
}

/// Script run elevated: drop old rules for the program (including blocks from
/// a dismissed prompt) and allow inbound TCP/UDP on all network profiles.
fn allow_script(exe: &str) -> String {
    format!(
        "$p = {exe}; \
         Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | \
           Where-Object {{ [Environment]::ExpandEnvironmentVariables($_.Program) -ieq $p }} | \
           Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object {{ $_.Direction -eq 'Inbound' }} | \
           Remove-NetFirewallRule -ErrorAction SilentlyContinue; \
         New-NetFirewallRule -DisplayName 'Domus Server' -Description 'Erlaubt Verbindungen zu in Domus gehosteten Servern' \
           -Direction Inbound -Action Allow -Program $p -Profile Any -Enabled True | Out-Null",
        exe = ps_quote(exe)
    )
}

/// UTF-16LE base64 for `powershell -EncodedCommand` (no quoting pitfalls).
fn encode_ps(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(windows)]
pub fn firewall_status() -> FirewallStatus {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
        .arg(encode_ps(&status_script(&exe_path())))
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let mut st = FirewallStatus { supported: true, ..Default::default() };
    match out {
        Ok(o) => match serde_json::from_slice::<serde_json::Value>(&o.stdout) {
            Ok(v) => {
                st.allow = v["allow"].as_u64().unwrap_or(0) as u32;
                st.block = v["block"].as_u64().unwrap_or(0) as u32;
                st.network = v["network"].as_str().unwrap_or("").to_string();
            }
            Err(_) => st.error = Some(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect()),
        },
        Err(e) => st.error = Some(e.to_string()),
    }
    st
}

#[cfg(not(windows))]
pub fn firewall_status() -> FirewallStatus {
    FirewallStatus::default()
}

/// Runs the allow script with administrator rights. Windows shows its UAC
/// prompt; declining returns an error with "cancelled".
#[cfg(windows)]
pub fn firewall_allow() -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let verb = wide("runas");
    let file = wide("powershell.exe");
    let params = wide(&format!(
        "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {}",
        encode_ps(&allow_script(&exe_path()))
    ));
    // SAFETY: all pointers reference live, NUL-terminated buffers for the
    // duration of the call; the returned process handle is closed below.
    unsafe {
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = params.as_ptr();
        info.nShow = SW_HIDE;
        if ShellExecuteExW(&mut info) == 0 {
            let err = std::io::Error::last_os_error();
            // ERROR_CANCELLED: the user declined the UAC prompt.
            return Err(if err.raw_os_error() == Some(1223) { "cancelled".into() } else { err.to_string() });
        }
        if info.hProcess.is_null() {
            return Err("Prozess konnte nicht gestartet werden".into());
        }
        let wait = WaitForSingleObject(info.hProcess, 60_000);
        let mut code: u32 = 1;
        GetExitCodeProcess(info.hProcess, &mut code);
        CloseHandle(info.hProcess);
        if wait != WAIT_OBJECT_0 {
            return Err("Zeitüberschreitung bei der Firewall-Freigabe".into());
        }
        if code != 0 {
            return Err(format!("Firewall-Freigabe fehlgeschlagen (Code {code})"));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn firewall_allow() -> Result<(), String> {
    Ok(())
}

// ------------------------------------------------------------------ router (UPnP)

#[derive(Debug, Clone, Default, Serialize)]
pub struct UpnpStatus {
    /// Ports were forwarded by the router.
    pub mapped: bool,
    /// Public address as reported by the router.
    pub external_ip: Option<String>,
    /// The router itself has no public IPv4 (carrier-grade NAT / DS-Lite):
    /// friends on the internet cannot connect directly.
    pub cgnat: bool,
    pub error: Option<String>,
}

/// Shared address space (RFC 6598) or private ranges → no public IPv4.
pub fn is_cgnat(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified() || (o[0] == 100 && (64..128).contains(&o[1]))
        }
        IpAddr::V6(_) => false,
    }
}

const LEASE_SECS: u32 = 3600;

async fn gateway() -> Result<igd_next::aio::Gateway<igd_next::aio::tokio::Tokio>, String> {
    let mut opts = igd_next::SearchOptions::default();
    opts.timeout = Some(Duration::from_secs(4));
    opts.single_search_timeout = Some(Duration::from_secs(2));
    igd_next::aio::tokio::search_gateway(opts).await.map_err(|e| format!("Kein UPnP-fähiger Router gefunden ({e})"))
}

/// Forwards TCP `port` and UDP `udp_port` (if any) to `lan_ip`.
pub async fn upnp_map(lan_ip: Ipv4Addr, port: u16, udp_port: Option<u16>) -> UpnpStatus {
    let mut st = UpnpStatus::default();
    let gw = match gateway().await {
        Ok(g) => g,
        Err(e) => {
            st.error = Some(e);
            return st;
        }
    };
    if let Ok(ip) = gw.get_external_ip().await {
        st.cgnat = is_cgnat(ip);
        st.external_ip = Some(ip.to_string());
    }
    use igd_next::PortMappingProtocol::{TCP, UDP};
    let local = |p: u16| SocketAddr::new(IpAddr::V4(lan_ip), p);
    match gw.add_port(TCP, port, local(port), LEASE_SECS, "Domus").await {
        Ok(()) => st.mapped = true,
        Err(e) => {
            st.error = Some(format!("Router hat die Weiterleitung abgelehnt ({e})"));
            return st;
        }
    }
    if let Some(u) = udp_port {
        // Voice still works through the relay-free path without it, so a
        // refusal here is not fatal.
        let _ = gw.add_port(UDP, u, local(u), LEASE_SECS, "Domus (Sprache)").await;
    }
    st
}

pub async fn upnp_unmap(port: u16, udp_port: Option<u16>) {
    if let Ok(gw) = gateway().await {
        let _ = gw.remove_port(igd_next::PortMappingProtocol::TCP, port).await;
        if let Some(u) = udp_port {
            let _ = gw.remove_port(igd_next::PortMappingProtocol::UDP, u).await;
        }
    }
}

/// Renew before the lease runs out.
pub const RENEW_EVERY: Duration = Duration::from_secs(LEASE_SECS as u64 - 300);

// ------------------------------------------------------------------ commands

#[tauri::command]
pub async fn firewall_check() -> FirewallStatus {
    tauri::async_runtime::spawn_blocking(firewall_status).await.unwrap_or_default()
}

#[tauri::command]
pub async fn firewall_open() -> Result<FirewallStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        firewall_allow()?;
        Ok(firewall_status())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cgnat_and_private_addresses_are_detected() {
        assert!(is_cgnat("100.64.1.2".parse().unwrap()));
        assert!(is_cgnat("100.127.255.1".parse().unwrap()));
        assert!(is_cgnat("192.168.0.1".parse().unwrap()));
        assert!(is_cgnat("10.1.2.3".parse().unwrap()));
        assert!(!is_cgnat("100.128.0.1".parse().unwrap()));
        assert!(!is_cgnat("84.150.12.7".parse().unwrap()));
    }

    #[test]
    fn scripts_quote_paths_safely() {
        let s = allow_script("C:\\Users\\O'Brien\\NexusTalk\\nexustalk.exe");
        assert!(s.contains("'C:\\Users\\O''Brien\\NexusTalk\\nexustalk.exe'"));
        assert!(s.contains("-Profile Any") && s.contains("-Action Allow") && s.contains("Remove-NetFirewallRule"));
        // EncodedCommand is UTF-16LE base64.
        use base64::Engine;
        let dec = base64::engine::general_purpose::STANDARD.decode(encode_ps("ab")).unwrap();
        assert_eq!(dec, vec![b'a', 0, b'b', 0]);
    }

    /// Read-only look at the local router: `cargo test -p nexustalk upnp_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn upnp_probe() {
        tauri::async_runtime::block_on(async {
            match gateway().await {
                Ok(gw) => {
                    let ip = gw.get_external_ip().await;
                    println!("router {} external {:?} cgnat {:?}", gw.addr, ip, ip.as_ref().map(|i| is_cgnat(*i)).ok());
                }
                Err(e) => println!("no gateway: {e}"),
            }
            println!("firewall {:?}", firewall_status());
        });
    }

    /// Both scripts must parse in PowerShell (checked without running them).
    #[cfg(windows)]
    #[test]
    fn scripts_are_valid_powershell() {
        let exe = r"C:\Program Files\Nexus Talk\nexustalk.exe";
        for script in [status_script(exe), allow_script(exe)] {
            let check = format!(
                "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{}')), [ref]$null, [ref]$e); $e.Count",
                encode_ps(&script)
            );
            let out = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &check]).output().unwrap();
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "0", "{script}\n{}", String::from_utf8_lossy(&out.stderr));
        }
    }

    #[cfg(windows)]
    #[test]
    fn firewall_status_runs_without_admin_rights() {
        let st = firewall_status();
        assert!(st.supported);
        assert!(st.error.is_none(), "{:?}", st.error);
    }
}

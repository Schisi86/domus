// Servers hosted by this desktop app (several at once, each on its own ports).
// The list is polled from the Rust side so the rail button and the hosting
// panel always show the live state.

import { computed, signal } from "@preact/signals";
import { isTauri, tauriInvoke } from "../platform";
import { servers } from "./app";
import type { ServerStore } from "./server";

export interface HostStatus {
  id: string;
  name: string;
  autostart: boolean;
  running: boolean;
  address: string | null;
  fingerprint: string | null;
  setup_code: string | null;
  error: string | null;
  data_dir: string;
  exposed: boolean;
  lan_ip: string | null;
  port: number;
  udp_port: number;
  tls: boolean;
  public_host: string;
  upnp: UpnpStatus | null;
  relay_enabled: boolean;
  relay: RelayStatus | null;
}

/** Internet relay tunnel (for connections without port forwarding, e.g. CGNAT). */
export interface RelayStatus {
  address: string | null;
  connecting: boolean;
  error: string | null;
}

export interface UpnpStatus {
  mapped: boolean;
  external_ip: string | null;
  cgnat: boolean;
  error: string | null;
}

export interface FirewallStatus {
  supported: boolean;
  allow: number;
  block: number;
  network: string;
  error: string | null;
}

export interface HostConfig {
  bind: string;
  port: number;
  public_host: string;
  tls: { enabled: boolean; cert_path: string; key_path: string };
  media: {
    stun_enabled: boolean;
    turn_enabled: boolean;
    udp_port: number;
    relay_ip: string;
    relay_port_min: number;
    relay_port_max: number;
    ice_servers: unknown[];
    max_voice_participants: number;
  };
  limits: Record<string, number>;
  log: { level: string; max_files: number };
}

export const hosts = signal<HostStatus[]>([]);
/** Windows Firewall state for NexUs (null = not checked yet). */
export const firewall = signal<FirewallStatus | null>(null);
export const firewallOk = (f: FirewallStatus | null) => !f || !f.supported || (f.allow > 0 && f.block === 0);

export async function checkFirewall() {
  if (!isTauri) return null;
  firewall.value = await tauriInvoke<FirewallStatus>("firewall_check").catch(() => null);
  return firewall.value;
}

/** Adds the firewall rule (Windows asks for administrator rights once). */
export async function openFirewall(): Promise<"ok" | "cancelled" | string> {
  try {
    firewall.value = await tauriInvoke<FirewallStatus>("firewall_open");
    return firewallOk(firewall.value) ? "ok" : "still blocked";
  } catch (e) {
    return String(e) === "cancelled" ? "cancelled" : String(e);
  }
}

/** Server reachable from the network but the firewall would drop connections. */
export const reachProblem = computed(() => hosts.value.some((h) => h.running && h.exposed) && !firewallOk(firewall.value));
export const runningHosts = computed(() => hosts.value.filter((h) => h.running).length);

export async function refreshHosts() {
  if (!isTauri) return;
  try {
    hosts.value = await tauriInvoke<HostStatus[]>("host_list");
  } catch {
    /* keep the last known state */
  }
}

/** Turns the internet relay on/off (a running server restarts briefly). */
export async function setRelay(id: string, enabled: boolean) {
  await tauriInvoke<HostStatus>("host_set_relay", { id, enabled });
  await refreshHosts();
}

/** Public invite address: router forwarding if it works, else the relay tunnel. */
export function internetAddress(h: HostStatus): { host: string; port: number; via: "upnp" | "relay" } | null {
  if (h.upnp?.mapped && !h.upnp.cgnat && h.upnp.external_ip) return { host: h.upnp.external_ip, port: h.port, via: "upnp" };
  const a = h.relay?.address;
  if (!a) return null;
  const i = a.lastIndexOf(":");
  return { host: a.slice(0, i), port: Number(a.slice(i + 1)), via: "relay" };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startHostPolling() {
  if (!isTauri || timer) return;
  void refreshHosts().then(() => {
    if (hosts.value.some((h) => h.exposed)) void checkFirewall();
  });
  timer = setInterval(() => void refreshHosts(), 4000);
}

/** The local address the app itself uses to reach a hosted server. */
export function localAddress(h: Pick<HostStatus, "tls" | "port">) {
  return `${h.tls ? "https" : "http"}://127.0.0.1:${h.port}`;
}

/** The client entry (owner account) that belongs to a hosted server. */
export function clientFor(hostId: string): ServerStore | undefined {
  return servers.value.find((s) => s.saved.value.host_id === hostId);
}

/** Display name: the live server name if connected, else the local label. */
export function hostName(h: HostStatus, fallback: string) {
  return clientFor(h.id)?.info.value?.name || h.name || fallback;
}

/** Waits until a server connection is ready (e.g. right after creating the owner). */
export function whenReady(s: ServerStore, timeoutMs = 15000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => {
      if (s.conn.state.value === "ready") return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

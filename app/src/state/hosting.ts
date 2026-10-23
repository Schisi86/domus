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
export const runningHosts = computed(() => hosts.value.filter((h) => h.running).length);

export async function refreshHosts() {
  if (!isTauri) return;
  try {
    hosts.value = await tauriInvoke<HostStatus[]>("host_list");
  } catch {
    /* keep the last known state */
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startHostPolling() {
  if (!isTauri || timer) return;
  void refreshHosts();
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

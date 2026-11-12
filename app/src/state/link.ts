// Move the profile to another device with a QR code (or a copied text code).
//
// The sending device asks every connected server for a one-time sign-in code
// (`device.link_create`, valid 3 minutes, usable once) and packs the codes,
// the addresses that are reachable from outside this device, the pinned
// certificate fingerprints and a few appearance settings into one text.
// The receiving device redeems each code at `POST /api/v1/auth/link` and gets
// its own new session – session tokens and passwords never leave a device.

import { addServer, servers, settings, updateSettings, type Settings } from "./app";
import type { ServerStore } from "./server";
import type { SavedServer } from "../types";
import { normalizeAddress, transport, isNetError } from "../net/transport";
import { hostFor, internetAddress } from "./hosting";
import { deviceName } from "../ui/dialogs/AddServer";
import { errorText, t } from "../i18n";

export const LINK_PREFIX = "domus-link:";

/** Settings that travel with the profile (look and notification habits). */
const CARRIED: (keyof Settings)[] = [
  "theme", "followSystemTheme", "accent", "ambient", "compact", "language", "msgScale",
  "notifyDMs", "notifyMentions", "notifyAll", "notifyVoiceJoin", "notifySound", "uiSounds", "soundboard", "soundboardVolume",
];

export interface LinkServer {
  /** server name */
  n: string;
  /** user name (shown before signing in) */
  u: string;
  /** addresses to try, best first */
  a: string[];
  /** pinned certificate fingerprint */
  f: string | null;
  /** one-time code */
  c: string;
}

export interface LinkPayload {
  v: 1;
  /** name of the sending device */
  d: string;
  s: LinkServer[];
  /** carried settings */
  p?: Partial<Settings>;
  /** expiry (ms since epoch) of the earliest code */
  x: number;
}

const isLoopback = (addr: string) => {
  const host = normalizeAddress(addr)?.host ?? "";
  return /^(localhost|127\.|::1$|0\.0\.0\.0)/.test(host);
};

/** Addresses under which another device can reach this server, best first. */
export function reachableAddresses(s: ServerStore): string[] {
  const out: string[] = [];
  const add = (a: string | null | undefined) => {
    if (a && !isLoopback(a) && !out.includes(a)) out.push(a);
  };
  add(s.saved.value.address);
  const h = hostFor(s);
  if (h) {
    const scheme = h.tls ? "" : "http://";
    if (h.public_host) add(`${scheme}${h.public_host}:${h.port}`);
    const inet = internetAddress(h);
    if (inet) add(`${scheme}${inet.host}:${inet.port}`);
    if (h.exposed && h.lan_ip) add(`${scheme}${h.lan_ip}:${h.port}`);
  }
  return out;
}

export interface PreparedLink {
  text: string;
  payload: LinkPayload;
  /** servers that could not be included, with the reason */
  skipped: { name: string; why: string }[];
}

/** Creates fresh codes on every connected server and builds the transfer text. */
export async function prepareLink(withSettings: boolean): Promise<PreparedLink> {
  const skipped: PreparedLink["skipped"] = [];
  const list: LinkServer[] = [];
  let expires = Number.MAX_SAFE_INTEGER;
  for (const s of servers.value) {
    const name = s.displayName();
    const addrs = reachableAddresses(s);
    if (!addrs.length) {
      skipped.push({ name, why: t("move.onlyLocal") });
      continue;
    }
    if (!s.conn.ready || !s.token) {
      skipped.push({ name, why: t("move.offline") });
      continue;
    }
    try {
      const r = await s.rpc<{ code: string; expires_at: number }>("device.link_create");
      expires = Math.min(expires, r.expires_at);
      list.push({ n: name, u: s.saved.value.username, a: addrs, f: s.saved.value.fingerprint ?? null, c: r.code });
    } catch (e) {
      // Servers older than Domus 1.0.1 do not know device linking yet.
      skipped.push({ name, why: (e as { code?: string })?.code === "UNKNOWN_OP" || /unbekannt|unknown/i.test(errorText(e)) ? t("move.tooOld") : errorText(e) });
    }
  }
  const p: Partial<Settings> = {};
  if (withSettings) for (const k of CARRIED) (p as Record<string, unknown>)[k] = settings.value[k];
  const payload: LinkPayload = { v: 1, d: deviceName(), s: list, p: withSettings ? p : undefined, x: list.length ? expires : Date.now() };
  return { text: encodeLink(payload), payload, skipped };
}

function b64url(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function encodeLink(p: LinkPayload) {
  return LINK_PREFIX + b64url(new TextEncoder().encode(JSON.stringify(p)));
}

/** Parses a scanned or pasted transfer text; null if it is none. */
export function decodeLink(text: string): LinkPayload | null {
  const s = text.trim();
  if (!s.startsWith(LINK_PREFIX)) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(fromB64url(s.slice(LINK_PREFIX.length).replace(/\s+/g, ""))));
    if (p?.v !== 1 || !Array.isArray(p.s)) return null;
    const servers = (p.s as LinkServer[]).filter(
      (x) => x && typeof x.c === "string" && Array.isArray(x.a) && x.a.length > 0 && x.a.every((a) => typeof a === "string" && !!normalizeAddress(a)),
    );
    return { v: 1, d: String(p.d ?? "").slice(0, 64), s: servers.slice(0, 50), p: typeof p.p === "object" && p.p ? p.p : undefined, x: Number(p.x) || 0 };
  } catch {
    return null;
  }
}

export type LinkResult = { name: string; state: "ok" | "exists" | "failed"; detail?: string };

/** An existing entry for the same account on the same server. */
function existing(l: LinkServer): ServerStore | undefined {
  return servers.value.find((s) => {
    const v = s.saved.value;
    if (v.username.toLowerCase() !== l.u.toLowerCase()) return false;
    if (l.f && v.fingerprint) return v.fingerprint.toUpperCase() === l.f.toUpperCase();
    const mine = normalizeAddress(v.address)?.base;
    return l.a.some((a) => normalizeAddress(a)?.base === mine);
  });
}

/** Redeems every code of a transfer text; returns one result per server. */
export async function applyLink(p: LinkPayload, withSettings: boolean, onProgress?: (r: LinkResult[]) => void): Promise<LinkResult[]> {
  const results: LinkResult[] = [];
  const report = (r: LinkResult) => {
    results.push(r);
    onProgress?.([...results]);
  };
  for (const l of p.s) {
    const have = existing(l);
    if (have && have.conn.state.value !== "auth_failed" && have.token) {
      report({ name: l.n, state: "exists" });
      continue;
    }
    let done = false;
    let lastErr: unknown = null;
    for (const address of l.a) {
      try {
        const r = await transport.http({ address, fingerprint: l.f }, "POST", "/api/v1/auth/link", null, { code: l.c, device: deviceName() });
        if (r.status !== 200) {
          lastErr = r.body?.error ?? { code: "INTERNAL", msg: `HTTP ${r.status}` };
          break; // the server answered: another address would give the same answer
        }
        const entry: SavedServer = {
          id: have?.id ?? crypto.randomUUID(),
          address,
          fingerprint: l.f,
          name: l.n,
          username: r.body.user.username,
          token: r.body.token,
          hosted: have?.saved.value.hosted,
          host_id: have?.saved.value.host_id,
        };
        addServer(entry, servers.value.length === 0);
        report({ name: l.n, state: "ok" });
        done = true;
        break;
      } catch (e) {
        lastErr = e;
        // A certificate that does not match the pinned one is never accepted.
        if (isNetError(e) && e.kind === "mismatch") break;
      }
    }
    if (!done) report({ name: l.n, state: "failed", detail: lastErr ? errorText(lastErr) : undefined });
  }
  if (withSettings && p.p) {
    const patch: Partial<Settings> = {};
    for (const k of CARRIED) if (k in p.p) (patch as Record<string, unknown>)[k] = (p.p as Record<string, unknown>)[k];
    updateSettings(patch);
  }
  return results;
}

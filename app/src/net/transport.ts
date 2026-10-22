// Transport abstraction. In the desktop app all network traffic goes through
// Rust (TLS with certificate pinning, see crates/nexus-net). In a plain
// browser (development, automated WebRTC tests) the native fetch/WebSocket
// APIs are used, which only work with plain HTTP or publicly trusted TLS.

import { isTauri } from "../platform";

export type NetError =
  | { kind: "untrusted"; fingerprint: string }
  | { kind: "mismatch"; expected: string; actual: string }
  | { kind: "bad_url"; message: string }
  | { kind: "connect"; message: string }
  | { kind: "timeout" }
  | { kind: "status"; status: number };

export const isNetError = (e: unknown): e is NetError => !!e && typeof e === "object" && "kind" in (e as object);

export interface Target {
  address: string;
  fingerprint?: string | null;
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
}

export interface SocketHandle {
  send(text: string): void;
  close(): void;
}

export type Progress = (done: number, total: number | null) => void;

export interface Transport {
  http<T = any>(t: Target, method: string, path: string, token?: string | null, body?: unknown): Promise<HttpResult<T>>;
  bytes(t: Target, path: string, token: string): Promise<Blob>;
  upload(t: Target, path: string, token: string, data: Blob, onProgress?: Progress): Promise<HttpResult>;
  /** Returns false if the user cancelled the save dialog. */
  download(t: Target, path: string, token: string, filename: string, onProgress?: Progress): Promise<boolean>;
  openSocket(id: string, t: Target, onMessage: (data: string) => void, onClose: (code: number, reason: string) => void): Promise<SocketHandle>;
}

/** Mirrors `nexus_net::parse_address`: default TLS and port 7878. */
export function normalizeAddress(input: string): { tls: boolean; base: string; host: string } | null {
  let s = input.trim().replace(/\/+$/, "");
  let tls = true;
  if (s.startsWith("https://")) s = s.slice(8);
  else if (s.startsWith("http://")) {
    tls = false;
    s = s.slice(7);
  } else if (s.startsWith("nexustalk://")) s = s.slice(12);
  const hostport = s.split("/")[0];
  if (!hostport || /\s/.test(hostport)) return null;
  let withPort: string;
  if (hostport.startsWith("[")) withPort = hostport.includes("]:") ? hostport : `${hostport}:7878`;
  else if ((hostport.match(/:/g) || []).length === 1) withPort = hostport;
  else if (hostport.includes(":")) withPort = `[${hostport}]:7878`;
  else withPort = `${hostport}:7878`;
  const host = withPort.startsWith("[") ? withPort.slice(1, withPort.indexOf("]")) : withPort.slice(0, withPort.lastIndexOf(":"));
  return { tls, base: `${tls ? "https" : "http"}://${withPort}`, host };
}

/** Parses invite links of the form `nexustalk://host:port/CODE#fp=FINGERPRINT`. */
export function parseInvite(input: string): { address: string; code: string; fingerprint: string | null } | null {
  const m = input.trim().match(/^nexustalk:\/\/([^/\s]+)\/([A-Za-z0-9]{4,32})(?:#fp=([0-9A-Fa-f:]{20,}))?$/);
  if (!m) return null;
  return { address: m[1], code: m[2].toUpperCase(), fingerprint: m[3] ? m[3].replace(/:/g, "").toUpperCase() : null };
}

export function inviteLink(host: string, port: number, code: string, fingerprint: string | null) {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `nexustalk://${h}:${port}/${code}${fingerprint ? `#fp=${fingerprint}` : ""}`;
}

// ---------------------------------------------------------------- Tauri

class TauriTransport implements Transport {
  private progress = new Map<string, Progress>();
  private listening: Promise<void> | null = null;

  private async core() {
    return import("@tauri-apps/api/core");
  }

  private ensureProgressListener() {
    if (!this.listening) {
      this.listening = import("@tauri-apps/api/event").then(({ listen }) =>
        listen<{ id: string; done: number; total: number | null }>("net://progress", (ev) => {
          this.progress.get(ev.payload.id)?.(ev.payload.done, ev.payload.total);
        }).then(() => undefined),
      );
    }
    return this.listening;
  }

  async http<T>(t: Target, method: string, path: string, token?: string | null, body?: unknown): Promise<HttpResult<T>> {
    const { invoke } = await this.core();
    const r = await invoke<{ status: number; body: string }>("net_http", {
      address: t.address,
      fingerprint: t.fingerprint ?? null,
      method,
      path,
      token: token ?? null,
      body: body === undefined ? null : JSON.stringify(body),
    });
    let parsed: any = r.body;
    try {
      parsed = r.body ? JSON.parse(r.body) : null;
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed };
  }

  async bytes(t: Target, path: string, token: string): Promise<Blob> {
    const { invoke } = await this.core();
    const buf = await invoke<ArrayBuffer>("net_bytes", { address: t.address, fingerprint: t.fingerprint ?? null, path, token });
    return new Blob([buf]);
  }

  async upload(t: Target, path: string, token: string, data: Blob, onProgress?: Progress): Promise<HttpResult> {
    const { invoke } = await this.core();
    await this.ensureProgressListener();
    const id = crypto.randomUUID();
    if (onProgress) this.progress.set(id, onProgress);
    try {
      const bytes = new Uint8Array(await data.arrayBuffer());
      const r = await invoke<{ status: number; body: string }>("net_upload", bytes, {
        headers: {
          "x-address": t.address,
          "x-fingerprint": t.fingerprint ?? "",
          "x-path": path,
          "x-token": token,
          "x-upload-id": id,
        },
      });
      let body: any = null;
      try {
        body = JSON.parse(r.body);
      } catch {
        /* ignore */
      }
      return { status: r.status, body };
    } finally {
      this.progress.delete(id);
    }
  }

  async download(t: Target, path: string, token: string, filename: string, onProgress?: Progress): Promise<boolean> {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({ defaultPath: filename, title: "Datei speichern" });
    if (!dest) return false;
    const { invoke } = await this.core();
    await this.ensureProgressListener();
    const id = crypto.randomUUID();
    if (onProgress) this.progress.set(id, onProgress);
    try {
      const status = await invoke<number>("net_download", {
        address: t.address,
        fingerprint: t.fingerprint ?? null,
        path,
        token,
        dest,
        downloadId: id,
      });
      if (status !== 200) throw { kind: "status", status } satisfies NetError;
      return true;
    } finally {
      this.progress.delete(id);
    }
  }

  async openSocket(id: string, t: Target, onMessage: (d: string) => void, onClose: (c: number, r: string) => void): Promise<SocketHandle> {
    const { invoke, Channel } = await this.core();
    const ch = new Channel<{ kind: "message"; data: string } | { kind: "close"; code: number; reason: string }>();
    ch.onmessage = (ev) => {
      if (ev.kind === "message") onMessage(ev.data);
      else onClose(ev.code, ev.reason);
    };
    await invoke("ws_open", { id, address: t.address, fingerprint: t.fingerprint ?? null, onEvent: ch });
    return {
      send: (text) => {
        invoke("ws_send", { id, text }).catch(() => {});
      },
      close: () => {
        invoke("ws_close", { id }).catch(() => {});
      },
    };
  }
}

// ---------------------------------------------------------------- Browser

class BrowserTransport implements Transport {
  private base(t: Target) {
    const n = normalizeAddress(t.address);
    if (!n) throw { kind: "bad_url", message: t.address } satisfies NetError;
    return n.base;
  }

  private async fetch(t: Target, path: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(this.base(t) + path, init);
    } catch (e) {
      if (e && typeof e === "object" && "kind" in e) throw e;
      throw { kind: "connect", message: String(e) } satisfies NetError;
    }
  }

  async http<T>(t: Target, method: string, path: string, token?: string | null, body?: unknown): Promise<HttpResult<T>> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await this.fetch(t, path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: r.status, body: parsed };
  }

  async bytes(t: Target, path: string, token: string): Promise<Blob> {
    const r = await this.fetch(t, path, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw { kind: "status", status: r.status } satisfies NetError;
    return r.blob();
  }

  upload(t: Target, path: string, token: string, data: Blob, onProgress?: Progress): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", this.base(t) + path);
      xhr.setRequestHeader("authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.lengthComputable ? e.total : null);
      xhr.onload = () => {
        let body: any = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        resolve({ status: xhr.status, body });
      };
      xhr.onerror = () => reject({ kind: "connect", message: "Upload fehlgeschlagen" } satisfies NetError);
      xhr.send(data);
    });
  }

  async download(t: Target, path: string, token: string, filename: string): Promise<boolean> {
    const blob = await this.bytes(t, path, token);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }

  openSocket(_id: string, t: Target, onMessage: (d: string) => void, onClose: (c: number, r: string) => void): Promise<SocketHandle> {
    return new Promise((resolve, reject) => {
      const url = this.base(t).replace(/^http/, "ws") + "/api/v1/ws";
      let opened = false;
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject({ kind: "timeout" } satisfies NetError);
        }
      }, 10_000);
      ws.onopen = () => {
        opened = true;
        clearTimeout(timer);
        resolve({ send: (text) => ws.readyState === WebSocket.OPEN && ws.send(text), close: () => ws.close() });
      };
      ws.onmessage = (ev) => onMessage(String(ev.data));
      ws.onclose = (ev) => {
        clearTimeout(timer);
        if (!opened) reject({ kind: "connect", message: `WebSocket ${ev.code}` } satisfies NetError);
        else onClose(ev.code, ev.reason);
      };
    });
  }
}

export const transport: Transport = isTauri ? new TauriTransport() : new BrowserTransport();

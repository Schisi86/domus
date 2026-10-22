// One live WebSocket session with a server: request/response correlation,
// events, heartbeat and automatic reconnection with backoff.

import { signal } from "@preact/signals";
import type { ApiErr, Ready } from "../types";
import { log } from "../platform";
import { isNetError, transport, type NetError, type SocketHandle, type Target } from "./transport";

export type ConnState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "auth_failed"
  | "cert_untrusted"
  | "cert_mismatch"
  | "stopped";

const BACKOFF = [1000, 2000, 4000, 8000, 15000, 30000];
const PING_EVERY = 30_000;
const PING_TIMEOUT = 10_000;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: ApiErr) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnHandlers {
  onReady(r: Ready, reconnect: boolean): void;
  onEvent(ev: string, d: any): void;
  onDown?(): void;
}

let socketSeq = 0;

export class ServerConnection {
  state = signal<ConnState>("stopped");
  error = signal<string | null>(null);
  certError = signal<NetError | null>(null);
  latency = signal<number | null>(null);
  nextRetryAt = signal<number | null>(null);

  private sock: SocketHandle | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private attempt = 0;
  private everReady = false;
  private stopped = true;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private id: string,
    private target: () => Target,
    private token: () => string | null | undefined,
    private handlers: ConnHandlers,
  ) {
    window.addEventListener("online", () => {
      if (this.state.value === "reconnecting") this.retryNow();
    });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.generation++;
    this.clearTimers();
    this.sock?.close();
    this.sock = null;
    this.failPending("OFFLINE");
    this.state.value = "stopped";
  }

  retryNow() {
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  get ready() {
    return this.state.value === "ready";
  }

  rpc<T = any>(op: string, d: unknown = {}, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.sock || (this.state.value !== "ready" && op !== "auth")) {
        reject({ code: "OFFLINE", msg: "Keine Verbindung" });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "TIMEOUT", msg: "Zeitüberschreitung" });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.send(JSON.stringify({ id, op, d }));
    });
  }

  private clearTimers() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private failPending(code: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject({ code, msg: code });
    }
    this.pending.clear();
  }

  private async connect() {
    const gen = ++this.generation;
    this.clearTimers();
    this.nextRetryAt.value = null;
    this.state.value = this.everReady ? "reconnecting" : "connecting";
    const token = this.token();
    if (!token) {
      this.state.value = "auth_failed";
      return;
    }
    let sock: SocketHandle;
    try {
      sock = await transport.openSocket(
        `${this.id}#${++socketSeq}`,
        this.target(),
        (data) => gen === this.generation && this.onMessage(data),
        (code, reason) => gen === this.generation && this.onClose(code, reason),
      );
    } catch (e) {
      if (gen !== this.generation) return;
      if (isNetError(e) && (e.kind === "untrusted" || e.kind === "mismatch")) {
        this.certError.value = e;
        this.state.value = e.kind === "untrusted" ? "cert_untrusted" : "cert_mismatch";
        this.stopped = true;
        return;
      }
      this.error.value = isNetError(e) ? (e.kind === "connect" ? e.message : e.kind) : String(e);
      this.scheduleRetry();
      return;
    }
    if (gen !== this.generation) {
      sock.close();
      return;
    }
    this.sock = sock;
    try {
      const ready = await this.rpc<Ready>("auth", { token }, 20_000);
      if (gen !== this.generation) return;
      const reconnect = this.everReady;
      this.attempt = 0;
      this.everReady = true;
      this.error.value = null;
      this.certError.value = null;
      this.state.value = "ready";
      this.pingTimer = setInterval(() => this.ping(), PING_EVERY);
      this.handlers.onReady(ready, reconnect);
    } catch (e) {
      if (gen !== this.generation) return;
      const err = e as ApiErr;
      if (err.code === "UNAUTHORIZED") {
        this.state.value = "auth_failed";
        this.stopped = true;
        this.sock?.close();
        return;
      }
      this.error.value = err.msg ?? String(e);
      this.sock?.close();
      this.scheduleRetry();
    }
  }

  private async ping() {
    const t0 = performance.now();
    try {
      await this.rpc("ping", {}, PING_TIMEOUT);
      this.latency.value = Math.round(performance.now() - t0);
    } catch {
      log("warn", `heartbeat to ${this.id} failed, reconnecting`);
      this.sock?.close();
      this.onClose(1006, "heartbeat timeout");
    }
  }

  private onMessage(data: string) {
    let f: any;
    try {
      f = JSON.parse(data);
    } catch {
      return;
    }
    if (f.re !== undefined && f.re !== null) {
      const p = this.pending.get(f.re);
      if (!p) return;
      this.pending.delete(f.re);
      clearTimeout(p.timer);
      if (f.ok) p.resolve(f.d);
      else p.reject(f.err as ApiErr);
      return;
    }
    if (f.ev) {
      try {
        this.handlers.onEvent(f.ev, f.d);
      } catch (e) {
        log("error", `event handler ${f.ev} failed: ${e}`);
      }
    }
  }

  private onClose(code: number, reason: string) {
    this.generation++;
    this.sock = null;
    this.clearTimers();
    this.failPending("OFFLINE");
    if (this.stopped) return;
    this.handlers.onDown?.();
    // 4001 unauthorized, 4003 banned / account deleted: do not retry.
    if (code === 4001 || code === 4003) {
      this.state.value = "auth_failed";
      this.error.value = code === 4003 ? "Zugang wurde vom Server entzogen." : null;
      this.stopped = true;
      return;
    }
    this.error.value = reason || null;
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped) return;
    this.state.value = this.everReady ? "reconnecting" : "connecting";
    const base = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    const delay = base + Math.random() * base * 0.3;
    this.attempt++;
    this.nextRetryAt.value = Date.now() + delay;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}

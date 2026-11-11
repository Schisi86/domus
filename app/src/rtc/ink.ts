// Drawing and pointing on a shared screen. Everyone in the call can mark
// something on anybody's stream; the marks travel over the call's data channel
// and every client paints them itself. The sharer additionally gets them in a
// transparent overlay on the real desktop (desktop app, whole-screen share).

import { signal } from "@preact/signals";
import { settings } from "../state/app";
import { isTauri, log, tauriInvoke } from "../platform";
import { INK_COLORS, POINTER_HOLD_MS, pruneStrokes, userColor, type Pointer, type Stroke } from "./inkdraw";
import type { VoiceSession } from "./voice";

export type InkTool = "off" | "pen" | "laser";

/** The tool I am using right now (shared by all stream tiles). */
export const inkTool = signal<InkTool>("off");
export const inkColor = signal(INK_COLORS[0]);

const MAX_STROKES = 150;
const MAX_POINTS = 4000;
const MAX_BATCH = 400;
const OVERLAY_IDLE_MS = 45_000;

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const unit = (v: number) => Math.max(0, Math.min(1, v));

export class InkSession {
  /** Stream owner → strokes on that stream. Plain data; the layers poll it. */
  strokes = new Map<number, Stroke[]>();
  /** Stream owner → (author → pointer). */
  pointers = new Map<number, Map<number, Pointer>>();
  /** Bumped on every change so idle layers know when to wake up. */
  version = signal(0);
  private seq = 0;
  private current: { stream: number; id: number; pending: number[]; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private ptrSentAt = 0;
  private overlayOpen = false;
  private overlayReady = false;
  private overlayQueue: Record<string, unknown>[] = [];
  private overlayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private v: VoiceSession) {
    v.onData("ink", (from, m) => this.onStroke(from, m));
    v.onData("inkc", (from, m) => this.onClear(from, m));
    v.onData("ptr", (from, m) => this.onPointer(from, m));
  }

  /** May `from` (or I) annotate the stream of `stream`? */
  allowed(stream: number) {
    return stream === this.v.selfId ? settings.value.allowInk : this.v.inkAllowed.value.get(stream) !== false;
  }

  private list(stream: number) {
    let l = this.strokes.get(stream);
    if (!l) this.strokes.set(stream, (l = []));
    return l;
  }

  private touch() {
    this.version.value++;
  }

  // ------------------------------------------------------------- receiving

  private addPoints(stream: number, from: number, id: number, color: string, width: number, pts: number[], end: boolean) {
    const now = Date.now();
    let l = pruneStrokes(this.list(stream), now);
    const key = `${from}:${id}`;
    let s = l.find((x) => x.key === key);
    if (!s) {
      if (l.length >= MAX_STROKES) l = l.slice(l.length - MAX_STROKES + 1);
      s = { key, from, color, width, pts: [], done: null };
      l.push(s);
    }
    this.strokes.set(stream, l);
    if (s.pts.length + pts.length <= MAX_POINTS) for (const p of pts) s.pts.push(p);
    if (end) s.done = now;
    this.touch();
    if (stream === this.v.selfId) this.toOverlay({ k: "stroke", key, color, width, pts, end });
  }

  private onStroke(from: number, m: any) {
    const stream = num(m.s);
    const id = num(m.i);
    if (stream === null || id === null || !Array.isArray(m.p) || m.p.length > MAX_BATCH || !this.allowed(stream)) return;
    if (!this.v.screens.value.has(stream)) return;
    const pts: number[] = [];
    for (const raw of m.p) {
      const n = num(raw);
      if (n === null) return;
      pts.push(unit(n / 10000));
    }
    if (pts.length % 2) pts.pop();
    const color = typeof m.c === "string" && /^#[0-9a-f]{6}$/i.test(m.c) ? m.c : userColor(from);
    const width = Math.max(0.002, Math.min(0.02, num(m.w) ?? 0.006));
    this.addPoints(stream, from, id, color, width, pts, !!m.e);
  }

  private onClear(from: number, m: any) {
    const stream = num(m.s);
    if (stream === null) return;
    // The sharer may wipe everything, everyone else only their own marks.
    this.removeStrokes(stream, m.all && from === stream ? null : from);
  }

  private removeStrokes(stream: number, author: number | null) {
    const l = this.strokes.get(stream);
    if (!l) return;
    this.strokes.set(stream, author === null ? [] : l.filter((s) => s.from !== author));
    this.touch();
    if (stream === this.v.selfId) this.toOverlay({ k: "clear", author });
  }

  private setPointer(stream: number, from: number, x: number | null, y: number | null) {
    let m = this.pointers.get(stream);
    if (!m) this.pointers.set(stream, (m = new Map()));
    const name = from === this.v.selfId ? "" : this.v.server.memberName(from);
    if (x === null || y === null) m.delete(from);
    else m.set(from, { x, y, at: Date.now(), color: userColor(from), name });
    this.touch();
    if (stream === this.v.selfId) this.toOverlay({ k: "ptr", from, x, y, color: userColor(from), name: this.v.server.memberName(from) });
  }

  private onPointer(from: number, m: any) {
    const stream = num(m.s);
    if (stream === null || !this.allowed(stream) || !this.v.screens.value.has(stream)) return;
    const x = num(m.x);
    const y = num(m.y);
    this.setPointer(stream, from, m.o || x === null ? null : unit(x / 10000), m.o || y === null ? null : unit(y / 10000));
  }

  // ------------------------------------------------------------- drawing myself

  private flush(end: boolean) {
    const c = this.current;
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    if (!c.pending.length && !end) return;
    const p = c.pending.map((v) => Math.round(v * 10000));
    c.pending = [];
    this.v.broadcast({ t: "ink", s: c.stream, i: c.id, c: inkColor.value, w: 0.006, p, ...(end ? { e: 1 } : {}) });
    if (end) this.current = null;
  }

  /** Pen down / move (`x`,`y` normalized to the stream picture). */
  draw(stream: number, x: number, y: number, start: boolean) {
    if (!this.allowed(stream)) return;
    if (start || !this.current || this.current.stream !== stream) {
      this.flush(true);
      this.current = { stream, id: ++this.seq, pending: [], timer: null };
    }
    const c = this.current!;
    x = unit(x);
    y = unit(y);
    this.addPoints(stream, this.v.selfId, c.id, inkColor.value, 0.006, [x, y], false);
    c.pending.push(x, y);
    if (c.pending.length >= 60) this.flush(false);
    else if (!c.timer) c.timer = setTimeout(() => this.flush(false), 45);
  }

  /** Pen up. */
  endStroke() {
    const c = this.current;
    if (!c) return;
    const l = this.strokes.get(c.stream);
    const s = l?.find((x) => x.key === `${this.v.selfId}:${c.id}`);
    if (s) s.done = Date.now();
    if (c.stream === this.v.selfId) this.toOverlay({ k: "stroke", key: `${this.v.selfId}:${c.id}`, color: inkColor.value, width: 0.006, pts: [], end: true });
    this.flush(true);
    this.touch();
  }

  /** Laser pointer: where I point on `stream` (null = pointer left the picture). */
  point(stream: number, x: number | null, y: number | null) {
    if (!this.allowed(stream)) return;
    const now = performance.now();
    if (x !== null && y !== null) {
      this.setPointer(stream, this.v.selfId, unit(x), unit(y));
      if (now - this.ptrSentAt < 33) return;
      this.ptrSentAt = now;
      this.v.broadcast({ t: "ptr", s: stream, x: Math.round(unit(x) * 10000), y: Math.round(unit(y) * 10000) });
    } else {
      this.setPointer(stream, this.v.selfId, null, null);
      this.v.broadcast({ t: "ptr", s: stream, o: 1 });
    }
  }

  /** Removes my marks from a stream – or all of them if it is my own stream. */
  clear(stream: number) {
    const all = stream === this.v.selfId;
    this.removeStrokes(stream, all ? null : this.v.selfId);
    this.v.broadcast({ t: "inkc", s: stream, ...(all ? { all: 1 } : {}) });
  }

  /** Is anything visible on `stream` right now? */
  active(stream: number, now = Date.now()) {
    const l = this.strokes.get(stream);
    if (l?.some((s) => s.done === null || now - s.done < 8200)) return true;
    const p = this.pointers.get(stream);
    if (p) for (const v of p.values()) if (now - v.at < POINTER_HOLD_MS) return true;
    return false;
  }

  streamEnded(stream: number) {
    this.strokes.delete(stream);
    this.pointers.delete(stream);
    if (this.current?.stream === stream) this.current = null;
    this.touch();
    if (stream === this.v.selfId) this.closeOverlay();
  }

  dispose() {
    this.strokes.clear();
    this.pointers.clear();
    this.current = null;
    this.closeOverlay();
    inkTool.value = "off";
  }

  // ------------------------------------------------------------- desktop overlay

  /** Marks on my own whole-screen share also appear on my real desktop. */
  private toOverlay(payload: Record<string, unknown>) {
    if (!isTauri || !this.v.screenIsMonitor.value || !this.v.sharingScreen.value) return;
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => this.closeOverlay(), OVERLAY_IDLE_MS);
    const emit = (pl: Record<string, unknown>) => void import("@tauri-apps/api/event").then((ev) => ev.emitTo("ink", "ink", pl)).catch(() => {});
    if (this.overlayReady) return emit(payload);
    // Until the overlay page has loaded, marks are queued so none get lost.
    this.overlayQueue.push(payload);
    if (this.overlayOpen) return;
    this.overlayOpen = true;
    tauriInvoke<boolean>("ink_overlay", { show: true })
      .then((ok) => {
        if (!ok) {
          this.overlayOpen = false;
          this.overlayQueue = [];
          return;
        }
        setTimeout(() => {
          if (!this.overlayOpen) return;
          this.overlayReady = true;
          this.overlayQueue.splice(0).forEach(emit);
        }, 600);
      })
      .catch((e) => {
        this.overlayOpen = false;
        this.overlayQueue = [];
        log("warn", `annotation overlay unavailable: ${e}`);
      });
  }

  private closeOverlay() {
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = null;
    this.overlayQueue = [];
    this.overlayReady = false;
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    void tauriInvoke("ink_overlay", { show: false }).catch(() => {});
  }
}

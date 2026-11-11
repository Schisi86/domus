// Direct file transfer between two users: the file goes straight from one
// computer to the other over an encrypted WebRTC data channel. The server only
// relays the short handshake, stores nothing, and its upload limit does not
// apply. Both sides have to be online for the duration of the transfer.

import { signal } from "@preact/signals";
import { settings, toast, voiceHooks } from "../state/app";
import type { ServerStore } from "../state/server";
import { errorText, t } from "../i18n";
import { log, notify, requestAttention, saveFile, type FileSink } from "../platform";
import { playChime } from "../sound";
import { iceServersFor } from "./voice";

export type TransferState = "offered" | "waiting" | "connecting" | "active" | "done" | "failed" | "declined" | "cancelled";

export interface Transfer {
  id: string;
  server: ServerStore;
  peer: number;
  dir: "send" | "recv";
  name: string;
  size: number;
  mime: string;
  /** Bytes transferred so far. */
  done: number;
  /** Bytes per second (smoothed). */
  speed: number;
  state: TransferState;
  error?: string;
}

interface Session {
  t: Transfer;
  file?: File;
  pc?: RTCPeerConnection;
  ch?: RTCDataChannel;
  sink?: FileSink;
  writes: Promise<void>;
  lastTick: number;
  lastDone: number;
  stopped: boolean;
}

/** All transfers of this app session, newest last. */
export const transfers = signal<Transfer[]>([]);
const sessions = new Map<string, Session>();

const CHUNK = 64 * 1024;
const BLOCK = 2 * 1024 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const ACTIVE: TransferState[] = ["offered", "waiting", "connecting", "active"];

function publish() {
  // Fresh copies: the list only re-renders entries whose object changed.
  transfers.value = [...sessions.values()].map((s) => ({ ...s.t }));
}

function update(s: Session, patch: Partial<Transfer>) {
  Object.assign(s.t, patch);
  publish();
}

function progress(s: Session, bytes: number) {
  s.t.done += bytes;
  const now = performance.now();
  if (now - s.lastTick < 250 && s.t.done < s.t.size) return;
  const dt = (now - s.lastTick) / 1000;
  const inst = dt > 0 ? (s.t.done - s.lastDone) / dt : 0;
  s.t.speed = s.t.speed ? s.t.speed * 0.6 + inst * 0.4 : inst;
  s.lastTick = now;
  s.lastDone = s.t.done;
  publish();
}

function send(s: Session, data: Record<string, unknown>) {
  return s.t.server.rpc("p2p.signal", { to: s.t.peer, data: { x: s.t.id, ...data } });
}

function finish(s: Session, state: TransferState, error?: string) {
  if (s.stopped) return;
  s.stopped = true;
  const keep = state === "done";
  if (s.sink) void s.writes.then(() => s.sink!.close(keep)).catch(() => {});
  // A moment for the last message ("done") to leave before the connection goes.
  setTimeout(() => {
    try {
      s.ch?.close();
    } catch {
      /* already closed */
    }
    s.pc?.close();
  }, keep ? 1200 : 0);
  update(s, { state, error, speed: 0 });
}

/** Resolves when all ICE candidates are in the local description (or after a short wait). */
function iceComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    pc.addEventListener("icegatheringstatechange", check);
    setTimeout(done, 4000);
  });
}

function connect(s: Session): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers: iceServersFor(s.t.server) });
  s.pc = pc;
  let lost: ReturnType<typeof setTimeout> | null = null;
  pc.onconnectionstatechange = () => {
    if (s.stopped) return;
    if (lost) clearTimeout(lost);
    if (pc.connectionState === "failed") finish(s, "failed", t("xfer.connLost"));
    // A short drop may recover by itself; give it a few seconds.
    else if (pc.connectionState === "disconnected") lost = setTimeout(() => finish(s, "failed", t("xfer.connLost")), 12_000);
  };
  return pc;
}

// ------------------------------------------------------------- sending

/** Offers `file` to `peer`; the transfer starts once they accept. */
export async function offerFile(server: ServerStore, peer: number, file: File): Promise<void> {
  const s: Session = {
    t: { id: crypto.randomUUID(), server, peer, dir: "send", name: file.name, size: file.size, mime: file.type, done: 0, speed: 0, state: "waiting" },
    file,
    writes: Promise.resolve(),
    lastTick: performance.now(),
    lastDone: 0,
    stopped: false,
  };
  try {
    await send(s, { k: "offer", name: file.name.slice(0, 255), size: file.size, mime: file.type.slice(0, 100) });
  } catch (e) {
    toast(t("xfer.offerFailed"), errorText(e), "error");
    return;
  }
  sessions.set(s.t.id, s);
  publish();
}

async function startSending(s: Session) {
  update(s, { state: "connecting" });
  const pc = connect(s);
  const ch = pc.createDataChannel("file", { ordered: true });
  s.ch = ch;
  ch.binaryType = "arraybuffer";
  ch.bufferedAmountLowThreshold = 1024 * 1024;
  ch.onopen = () => void pump(s).catch((e) => finish(s, "failed", String(e)));
  ch.onmessage = (e) => {
    if (e.data === "done") finish(s, "done");
    else if (e.data === "fail") finish(s, "failed", t("xfer.peerFailed"));
  };
  ch.onclose = () => finish(s, "failed", t("xfer.connLost"));
  try {
    await pc.setLocalDescription(await pc.createOffer());
    await iceComplete(pc);
    await send(s, { k: "sdp", sdp: pc.localDescription!.toJSON() });
  } catch (e) {
    finish(s, "failed", errorText(e));
  }
}

async function pump(s: Session) {
  const ch = s.ch!;
  const file = s.file!;
  update(s, { state: "active" });
  s.lastTick = performance.now();
  for (let offset = 0; offset < file.size; offset += BLOCK) {
    const block = new Uint8Array(await file.slice(offset, offset + BLOCK).arrayBuffer());
    for (let o = 0; o < block.length; o += CHUNK) {
      if (s.stopped || ch.readyState !== "open") return;
      if (ch.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((resolve) => {
          ch.onbufferedamountlow = () => resolve();
          // Also wake up if the channel closes while waiting.
          setTimeout(resolve, 5000);
        });
      }
      const piece = block.subarray(o, o + CHUNK);
      ch.send(piece);
      progress(s, piece.length);
    }
  }
  if (!s.stopped && ch.readyState === "open") ch.send(JSON.stringify({ k: "eof", size: file.size }));
}

// ------------------------------------------------------------- receiving

/** Accepts an offered file: asks where to save it, then connects. */
export async function acceptTransfer(id: string) {
  const s = sessions.get(id);
  if (!s || s.t.state !== "offered") return;
  let sink: FileSink | null;
  try {
    sink = await saveFile(s.t.name, s.t.mime || undefined);
  } catch (e) {
    toast(t("xfer.saveFailed"), String(e), "error");
    return;
  }
  if (!sink || s.t.state !== "offered") {
    if (sink) void sink.close(false);
    return;
  }
  s.sink = sink;
  update(s, { state: "connecting" });
  const pc = connect(s);
  pc.ondatachannel = (ev) => {
    const ch = ev.channel;
    s.ch = ch;
    ch.binaryType = "arraybuffer";
    s.lastTick = performance.now();
    update(s, { state: "active" });
    ch.onmessage = (e) => {
      if (s.stopped) return;
      if (typeof e.data === "string") {
        // End marker: everything must have arrived and be written.
        s.writes = s.writes.then(() => {
          if (s.stopped) return;
          if (s.t.done !== s.t.size) {
            ch.send("fail");
            return finish(s, "failed", t("xfer.incomplete"));
          }
          ch.send("done");
          finish(s, "done");
          toast(t("xfer.received"), s.t.name, "ok", 6000);
        });
        return;
      }
      const chunk = new Uint8Array(e.data as ArrayBuffer);
      if (s.t.done + chunk.length > s.t.size) return finish(s, "failed", t("xfer.incomplete"));
      progress(s, chunk.length);
      s.writes = s.writes
        .then(() => sink!.write(chunk))
        .catch((err) => {
          try {
            ch.send("fail");
          } catch {
            /* channel gone */
          }
          finish(s, "failed", t("xfer.saveFailed") + ": " + String(err));
        });
    };
    ch.onclose = () => finish(s, "failed", t("xfer.connLost"));
  };
  try {
    await send(s, { k: "accept" });
  } catch (e) {
    finish(s, "failed", errorText(e));
  }
}

export function declineTransfer(id: string) {
  const s = sessions.get(id);
  if (!s || s.t.state !== "offered") return;
  void send(s, { k: "decline" }).catch(() => {});
  s.stopped = true;
  update(s, { state: "declined" });
}

/** Stops a running or waiting transfer on both sides. */
export function cancelTransfer(id: string) {
  const s = sessions.get(id);
  if (!s || !ACTIVE.includes(s.t.state)) return;
  void send(s, { k: "cancel" }).catch(() => {});
  finish(s, "cancelled");
}

/** Removes a finished entry from the list. */
export function dismissTransfer(id: string) {
  const s = sessions.get(id);
  if (!s || ACTIVE.includes(s.t.state)) return;
  sessions.delete(id);
  publish();
}

export function transferActive(tr: Transfer) {
  return ACTIVE.includes(tr.state);
}

// ------------------------------------------------------------- signaling

async function onSignal(server: ServerStore, from: number, d: any) {
  if (!d || typeof d.x !== "string" || d.x.length > 64) return;
  let s = sessions.get(d.x);
  if (d.k === "offer") {
    if (s || typeof d.name !== "string" || typeof d.size !== "number" || !Number.isFinite(d.size) || d.size < 0) return;
    // Keep the name harmless: no paths, no control characters.
    const name = d.name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 255) || "datei";
    s = {
      t: { id: d.x, server, peer: from, dir: "recv", name, size: d.size, mime: typeof d.mime === "string" ? d.mime.slice(0, 100) : "", done: 0, speed: 0, state: "offered" },
      writes: Promise.resolve(),
      lastTick: performance.now(),
      lastDone: 0,
      stopped: false,
    };
    sessions.set(d.x, s);
    publish();
    const who = server.memberName(from);
    if (settings.value.notifications && server.me.value?.presence !== "dnd") {
      if (settings.value.notifySound) playChime();
      void notify(t("xfer.incomingTitle", { name: who }), name);
      void requestAttention();
    }
    return;
  }
  if (!s || s.t.peer !== from || s.t.server !== server || s.stopped) return;
  try {
    if (d.k === "accept" && s.t.dir === "send" && s.t.state === "waiting") await startSending(s);
    else if (d.k === "decline" && s.t.dir === "send") {
      s.stopped = true;
      update(s, { state: "declined" });
    } else if (d.k === "cancel") finish(s, "cancelled");
    else if (d.k === "sdp" && d.sdp && s.pc) {
      if (s.t.dir === "recv" && d.sdp.type === "offer") {
        await s.pc.setRemoteDescription(d.sdp);
        await s.pc.setLocalDescription(await s.pc.createAnswer());
        await iceComplete(s.pc);
        await send(s, { k: "sdp", sdp: s.pc.localDescription!.toJSON() });
      } else if (s.t.dir === "send" && d.sdp.type === "answer") await s.pc.setRemoteDescription(d.sdp);
    }
  } catch (e) {
    log("warn", `direct transfer ${s.t.id} failed: ${e}`);
    finish(s, "failed", errorText(e));
  }
}

voiceHooks.add((store, ev, d) => {
  if (ev === "p2p.signal") void onSignal(store, d.from, d.data);
});

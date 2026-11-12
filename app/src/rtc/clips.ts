// Instant clips: the last seconds of a stream as a video file. Two recorders
// run staggered in the background and restart in turn, so at any moment one
// of them holds the recent past (a recording cannot be cut afterwards, so the
// clip is up to two times the chosen length). Everything stays in
// this client's memory until the user actually saves or shares a clip.

import { effect, signal } from "@preact/signals";
import { settings, toast } from "../state/app";
import { t } from "../i18n";
import { log } from "../platform";
import type { VoiceSession } from "./voice";

interface Segment {
  rec: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
}

export interface Clip {
  blob: Blob;
  seconds: number;
  name: string;
  /** Whose stream it shows. */
  uid: number;
}

// avc3 keeps working when the stream changes its resolution while recording.
const MIMES = ["video/mp4;codecs=avc3.640028,mp4a.40.2", "video/mp4;codecs=avc1.640028,mp4a.40.2", "video/webm;codecs=h264,opus", "video/webm;codecs=vp8,opus", "video/webm"];

export function clipMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export class ClipBuffer {
  /** The stream currently kept in the buffer (null = buffer is off). */
  source = signal<number | null>(null);
  busy = signal(false);
  /** The stream the user is looking at (focused tile); buffered with priority. */
  preferred = signal<number | null>(null);

  private stream: MediaStream | null = null;
  private segs: Segment[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopEffect: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private nodes = new Map<string, MediaStreamAudioSourceNode>();
  private mixed: MediaStream | null = null;
  private lastNotice = 0;

  constructor(private v: VoiceSession) {
    v.onData("clip", (from) => {
      // Tell people that a recording of the call was made (at most every 20 s).
      if (Date.now() - this.lastNotice < 20_000) return;
      this.lastNotice = Date.now();
      toast(t("clip.madeBy", { name: v.server.memberName(from) }), undefined, "info", 4000);
    });
  }

  start() {
    this.stopEffect = effect(() => {
      const on = settings.value.clips && clipMime() !== null;
      const screens = this.v.screens.value;
      void settings.value.clipSeconds;
      void settings.value.clipVoices;
      const pref = this.preferred.value;
      // My own share first, then the tile I am looking at, then any stream.
      const uid = !on ? null : screens.has(this.v.selfId) ? this.v.selfId : pref !== null && screens.has(pref) ? pref : (screens.keys().next().value ?? null);
      const stream = uid !== null ? (screens.get(uid) ?? null) : null;
      queueMicrotask(() => this.retarget(uid, stream));
    });
  }

  stop() {
    this.stopEffect?.();
    this.stopEffect = null;
    this.teardown();
  }

  private len() {
    return Math.max(10, Math.min(120, settings.value.clipSeconds)) * 1000;
  }

  private retarget(uid: number | null, stream: MediaStream | null) {
    if (this.v.state.value === "ended") return;
    if (uid === this.source.value && stream === this.stream) return;
    this.teardown();
    if (uid === null || !stream || !stream.getVideoTracks().length) return;
    try {
      this.setup(uid, stream);
    } catch (e) {
      log("warn", `clip buffer unavailable: ${e}`);
      this.teardown();
    }
  }

  private setup(uid: number, stream: MediaStream) {
    this.stream = stream;
    this.source.value = uid;
    this.ctx = new AudioContext();
    this.dest = this.ctx.createMediaStreamDestination();
    this.connectAudio();
    this.mixed = new MediaStream([stream.getVideoTracks()[0], ...this.dest.stream.getAudioTracks()]);
    this.spawn();
    // The second recorder starts half a cycle later; each restarts after two lengths.
    this.timer = setInterval(() => this.tick(), 1000);
  }

  /** Mixes the stream's own sound and – if wanted – the voices of the call. */
  private connectAudio() {
    if (!this.ctx || !this.dest || this.source.value === null) return;
    const wanted = new Map<string, MediaStream>();
    const sys = this.v.screenAudio(this.source.value);
    if (sys) wanted.set(sys.id, sys);
    if (settings.value.clipVoices) for (const s of this.v.voiceStreams()) wanted.set(s.id, s);
    for (const [id, node] of this.nodes) {
      if (!wanted.has(id)) {
        node.disconnect();
        this.nodes.delete(id);
      }
    }
    for (const [id, s] of wanted) {
      if (this.nodes.has(id)) continue;
      try {
        const node = this.ctx.createMediaStreamSource(s);
        node.connect(this.dest);
        this.nodes.set(id, node);
      } catch {
        /* stream without a live audio track */
      }
    }
  }

  private spawn() {
    if (!this.mixed) return;
    const mime = clipMime();
    if (!mime) return;
    const seg: Segment = { rec: new MediaRecorder(this.mixed, { mimeType: mime, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 128_000 }), chunks: [], startedAt: Date.now() };
    seg.rec.ondataavailable = (e) => {
      if (e.data.size) seg.chunks.push(e.data);
    };
    seg.rec.start(1000);
    this.segs.push(seg);
  }

  private drop(seg: Segment) {
    this.segs = this.segs.filter((s) => s !== seg);
    seg.rec.ondataavailable = null;
    try {
      if (seg.rec.state !== "inactive") seg.rec.stop();
    } catch {
      /* already stopped */
    }
    seg.chunks = [];
  }

  private tick() {
    const now = Date.now();
    const L = this.len();
    this.connectAudio();
    for (const seg of [...this.segs]) if (now - seg.startedAt >= 2 * L) this.drop(seg);
    const newest = Math.max(0, ...this.segs.map((s) => s.startedAt));
    if (this.segs.length < 2 && now - newest >= L) this.spawn();
  }

  private teardown() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const seg of [...this.segs]) this.drop(seg);
    for (const n of this.nodes.values()) n.disconnect();
    this.nodes.clear();
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.dest = null;
    this.mixed = null;
    this.stream = null;
    if (this.source.value !== null) this.source.value = null;
  }

  /** Cuts the clip: everything the oldest running recorder has seen. */
  async capture(): Promise<Clip | null> {
    const uid = this.source.value;
    if (uid === null || this.busy.value || !this.segs.length) return null;
    const seg = this.segs.reduce((a, b) => (a.startedAt <= b.startedAt ? a : b));
    this.busy.value = true;
    try {
      // The recorder keeps running: its data so far is already a complete file.
      const blob = await new Promise<Blob>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          seg.rec.removeEventListener("dataavailable", done);
          resolve(new Blob(seg.chunks, { type: seg.rec.mimeType.split(";")[0] }));
        };
        seg.rec.addEventListener("dataavailable", done);
        if (seg.rec.state === "recording") seg.rec.requestData();
        setTimeout(done, 1500);
      });
      const seconds = Math.round((Date.now() - seg.startedAt) / 1000);
      if (!blob.size) return null;
      if (settings.value.clipVoices) this.v.broadcast({ t: "clip" });
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      return { blob, seconds, uid, name: `Domus-Clip_${stamp}.${blob.type.includes("mp4") ? "mp4" : "webm"}` };
    } catch (e) {
      log("warn", `clip failed: ${e}`);
      return null;
    } finally {
      this.busy.value = false;
    }
  }
}

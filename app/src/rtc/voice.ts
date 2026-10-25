// Voice/video/screen session: a WebRTC mesh between the participants of one
// voice channel. The server only relays signaling (SDP/ICE); media flows
// directly between clients or, if configured, through the TURN relay.
//
// Negotiation follows the "perfect negotiation" pattern so both sides can add
// or remove tracks (screen, camera) at any time without glare problems.

import { signal } from "@preact/signals";
import { settings, toast, voiceHooks, type ScreenOpts, type ScreenRes } from "../state/app";
import type { ServerStore } from "../state/server";
import type { IceConfig, VoiceMember } from "../types";
import { errorText, t } from "../i18n";
import { isTauri, log, tauriInvoke } from "../platform";
import { normalizeAddress } from "../net/transport";
import { play, playBoard, preloadBoard } from "../sound";
import { createGate, type Gate } from "./gate";

export type StreamKind = "mic" | "screen" | "camera";

export interface PeerStats {
  state: RTCPeerConnectionState;
  rtt: number | null;
  loss: number | null;
  relay: boolean;
  quality: "good" | "ok" | "bad" | "connecting";
}

export const SCREEN_RES: Record<ScreenRes, [number, number]> = {
  "720": [1280, 720],
  "1080": [1920, 1080],
  "1440": [2560, 1440],
  "2160": [3840, 2160],
  // "Original": no downscaling (capped at 4K); bitrate estimated for 1440p.
  source: [3840, 2160],
};
export const SCREEN_FPS = [5, 15, 30, 60];

/** Capture constraints and encoder limits for the chosen screen options. */
export function screenParams(o: ScreenOpts = settings.value.screen) {
  const [width, height] = SCREEN_RES[o.res] ?? SCREEN_RES["1080"];
  const fps = Math.max(1, Math.min(60, o.fps));
  const motion = o.content === "motion" || (o.content === "auto" && fps >= 30);
  // Bits per pixel and frame: fluid content needs more than mostly static text.
  const [ew, eh] = o.res === "source" ? SCREEN_RES["1440"] : [width, height];
  const auto = Math.round((ew * eh * fps * (motion ? 0.06 : 0.04)) / 1000 / 100) * 100;
  const kbps = o.kbps > 0 ? o.kbps : Math.max(500, Math.min(16000, auto));
  return { width, height, fps, kbps, motion };
}

function screenProfile() {
  return screenParams();
}

interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  kinds?: Record<string, StreamKind>;
}

class Peer {
  pc: RTCPeerConnection;
  makingOffer = false;
  ignoreOffer = false;
  remoteKinds = new Map<string, StreamKind>();
  micEl = new Audio();
  screenAudioEl = new Audio();
  micTrackId: string | null = null;
  pendingLocal: boolean;
  lostPrev = 0;
  recvPrev = 0;
  restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Bidirectional data channel for remote-control messages. */
  ctrl: RTCDataChannel | null = null;

  constructor(public uid: number, public polite: boolean, config: RTCConfiguration, initiator: boolean) {
    this.pc = new RTCPeerConnection(config);
    this.pendingLocal = !initiator;
    this.micEl.autoplay = true;
    this.screenAudioEl.autoplay = true;
  }

  close() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    try {
      this.ctrl?.close();
    } catch {
      /* already closed */
    }
    this.pc.close();
    for (const el of [this.micEl, this.screenAudioEl]) {
      el.pause();
      el.srcObject = null;
    }
  }
}

/** Hides WebView2's floating "sharing your screen" bar while a share runs (desktop app). */
let captureUsers = 0;
function captureBar(active: boolean) {
  // Screen share and webcam system audio can both hold a capture.
  captureUsers = Math.max(0, captureUsers + (active ? 1 : -1));
  if (isTauri) void tauriInvoke("capture_bar_hide", { active: captureUsers > 0 }).catch(() => {});
}

const SYSTEM_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, restrictOwnAudio: true };

export class VoiceSession {
  state = signal<"connecting" | "connected" | "reconnecting" | "ended">("connecting");
  muted = signal(false);
  deafened = signal(false);
  pttDown = signal(false);
  hasMic = signal(false);
  micLevel = signal(0);
  speaking = signal<Set<number>>(new Set());
  stats = signal<Map<number, PeerStats>>(new Map());
  screens = signal<Map<number, MediaStream>>(new Map());
  cameras = signal<Map<number, MediaStream>>(new Map());
  sharingScreen = signal(false);
  screenHasAudio = signal<boolean | null>(null);
  /** Whether the current share is the whole screen (remote control needs this). */
  screenIsMonitor = signal(false);
  cameraOn = signal(false);
  /** Remote control: whether others may control me, and the password I set. */
  remoteAllowed = signal(false);
  remotePassword = signal("");
  /** The uid currently controlling my computer, or null. */
  controlledBy = signal<number | null>(null);
  /** The uid whose computer I am controlling, or null. */
  controlling = signal<number | null>(null);
  /** The webcam stream also carries system audio. */
  cameraHasAudio = signal(false);
  private cameraAudioTrack: MediaStreamTrack | null = null;
  suppressed = signal(false);
  /** Muted / deafened by a moderator. */
  serverMuted = signal(false);
  serverDeafened = signal(false);
  /** Floating call reactions (shown for a few seconds over the tile). */
  reactions = signal<{ id: number; uid: number; emoji: string; x: number }[]>([]);
  private reactionSeq = 0;

  private mic: MediaStream | null = null;
  /** Unprocessed microphone (the gated copy in `mic` is what peers get). */
  private rawMic: MediaStream | null = null;
  private gate: Gate | null = null;
  private screen: MediaStream | null = null;
  private camera: MediaStream | null = null;
  private peers = new Map<number, Peer>();
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private loops: ReturnType<typeof setInterval>[] = [];
  private hook = (store: ServerStore, ev: string, d: any) => this.onServerEvent(store, ev, d);
  private keyDown = (e: KeyboardEvent) => this.onKey(e, true);
  private keyUp = (e: KeyboardEvent) => this.onKey(e, false);
  readonly selfId: number;
  /** Other people in the channel – to play a cue when someone joins or leaves. */
  private present = new Set<number>();

  private constructor(public server: ServerStore, public channelId: number) {
    this.selfId = server.me.value!.id;
  }

  static async join(server: ServerStore, channelId: number): Promise<VoiceSession> {
    const s = new VoiceSession(server, channelId);
    await s.start();
    return s;
  }

  // ------------------------------------------------------------- lifecycle

  private async start() {
    preloadBoard();
    await this.openMic();
    voiceHooks.add(this.hook);
    window.addEventListener("keydown", this.keyDown);
    window.addEventListener("keyup", this.keyUp);
    await this.registerGlobalPtt();
    await this.joinChannel(false);
    this.loops.push(setInterval(() => this.pollSpeaking(), 200));
    this.loops.push(setInterval(() => void this.pollStats(), 2000));
  }

  private async openMic() {
    const st = settings.value;
    try {
      this.rawMic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined,
          echoCancellation: st.echoCancellation,
          noiseSuppression: st.noiseSuppression,
          autoGainControl: st.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
      this.mic = this.rawMic;
      this.hasMic.value = true;
      await this.setupAnalyser();
    } catch (e) {
      this.mic = null;
      this.rawMic = null;
      this.hasMic.value = false;
      const name = (e as DOMException)?.name;
      const msg =
        name === "NotAllowedError"
          ? t("voice.micDenied")
          : name === "NotFoundError" || name === "OverconstrainedError"
            ? t("voice.micMissing")
            : t("voice.micError", { detail: String(e) });
      toast(t("voice.noMicJoined"), msg, "warn", 9000);
    }
    this.applyMicEnabled();
  }

  /** Audio chain: microphone → input-sensitivity gate → peers; analyser on the gated signal. */
  private async setupAnalyser() {
    if (!this.rawMic) return;
    try {
      void this.audioCtx?.close();
      this.audioCtx = new AudioContext();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      this.gate = null;
      const st = settings.value;
      if (st.inputGate !== "off") {
        try {
          this.gate = await createGate(this.audioCtx, this.rawMic);
          this.gate.configure(st.inputGate, st.gateThreshold);
          this.mic = this.gate.stream;
        } catch (e) {
          log("warn", `input gate unavailable: ${e}`);
          this.mic = this.rawMic;
        }
      }
      this.audioCtx.createMediaStreamSource(this.mic!).connect(this.analyser);
    } catch {
      this.analyser = null;
    }
  }

  /** Applies changed input-sensitivity settings without reconnecting. */
  updateGate() {
    const st = settings.value;
    if (this.gate && st.inputGate !== "off") this.gate.configure(st.inputGate, st.gateThreshold);
    else void this.changeInputDevice();
  }

  private async joinChannel(rejoin: boolean) {
    const r = await this.server.rpc<{ participants: VoiceMember[]; self: VoiceMember; ice?: IceConfig }>("voice.join", {
      channel_id: this.channelId,
      muted: this.muted.value || !this.hasMic.value,
      deafened: this.deafened.value,
    });
    this.suppressed.value = r.self.suppressed;
    this.serverMuted.value = !!r.self.server_muted;
    this.serverDeafened.value = !!r.self.server_deafened;
    // Fresh relay data (e.g. the TURN tunnel address may have changed since login).
    if (r.ice) this.server.ice = r.ice;
    const ids = new Set(r.participants.map((p) => p.user_id));
    for (const uid of ids) if (uid !== this.selfId) this.present.add(uid);
    // Drop peers that are gone; connect to everyone we do not know yet. After a
    // reconnect (possibly a server restart with an empty voice registry) the
    // others may simply not have rejoined yet, so their running media
    // connections get a grace period instead of being torn down.
    for (const uid of this.peers.keys()) {
      if (ids.has(uid)) continue;
      if (!rejoin) this.closePeer(uid);
      else
        setTimeout(() => {
          const v = this.server.voice.value.get(uid);
          if (this.state.value !== "ended" && (!v || v.channel_id !== this.channelId)) this.closePeer(uid);
        }, 25_000);
    }
    for (const p of r.participants) {
      if (p.user_id !== this.selfId && !this.peers.has(p.user_id)) this.createPeer(p.user_id, true);
    }
    if (rejoin && this.sharingScreen.value) await this.server.rpc("voice.update", { screen: true }).catch(() => {});
    if (rejoin && this.cameraOn.value) await this.server.rpc("voice.update", { video: true }).catch(() => {});
    this.state.value = "connected";
  }

  async leave() {
    if (this.state.value === "ended") return;
    this.releaseControl();
    this.revokeControl();
    this.state.value = "ended";
    voiceHooks.delete(this.hook);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    void this.unregisterGlobalPtt();
    this.loops.forEach(clearInterval);
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    if (this.screen) captureBar(false);
    if (this.cameraAudioTrack) captureBar(false);
    for (const s of [this.mic, this.rawMic, this.screen, this.camera]) s?.getTracks().forEach((t) => t.stop());
    this.mic = this.rawMic = this.screen = this.camera = null;
    void this.audioCtx?.close();
    this.screens.value = new Map();
    this.cameras.value = new Map();
    if (this.server.conn.ready) await this.server.rpc("voice.leave").catch(() => {});
  }

  // ------------------------------------------------------------- peers

  private iceServers(): RTCIceServer[] {
    const ice = this.server.ice;
    const host = normalizeAddress(this.server.saved.value.address)?.host ?? "localhost";
    const h = host.includes(":") ? `[${host}]` : host;
    const list: RTCIceServer[] = [];
    if (ice?.stun_port) list.push({ urls: `stun:${h}:${ice.stun_port}` });
    if (ice?.turn) {
      const { username, credential } = ice.turn;
      const urls = [`turn:${h}:${ice.turn.port}?transport=udp`];
      if (ice.turn.tcp) urls.push(`turn:${h}:${ice.turn.port}?transport=tcp`);
      list.push({ urls, username, credential });
      // Reachable from anywhere: TURN over TCP through the host's internet tunnel.
      if (ice.turn.public) list.push({ urls: `turn:${ice.turn.public}?transport=tcp`, username, credential });
    }
    for (const s of ice?.servers ?? []) list.push({ urls: s.urls, username: s.username, credential: s.credential });
    // Public STUN as fallback: needed when the server is only reachable through
    // the internet relay or sits behind CGNAT (its own STUN port is unreachable).
    list.push({ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] });
    return list;
  }

  private localKinds(): Record<string, StreamKind> {
    const k: Record<string, StreamKind> = {};
    if (this.mic) k[this.mic.id] = "mic";
    if (this.screen) k[this.screen.id] = "screen";
    if (this.camera) k[this.camera.id] = "camera";
    return k;
  }

  private signal(uid: number, data: SignalData) {
    this.server.rpc("rtc.signal", { to: uid, data }).catch((e) => log("warn", `signal to ${uid} failed: ${errorText(e)}`));
  }

  private attachLocal(peer: Peer) {
    const pc = peer.pc;
    if (this.mic) for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
    else if (!pc.getTransceivers().some((t) => t.receiver.track.kind === "audio")) pc.addTransceiver("audio", { direction: "recvonly" });
    if (this.screen) for (const t of this.screen.getTracks()) pc.addTrack(t, this.screen);
    if (this.camera) for (const t of this.camera.getTracks()) pc.addTrack(t, this.camera);
  }

  private createPeer(uid: number, initiator: boolean): Peer {
    const peer = new Peer(uid, this.selfId < uid, { iceServers: this.iceServers(), bundlePolicy: "max-bundle" }, initiator);
    this.peers.set(uid, peer);
    this.applyOutput(peer);
    const pc = peer.pc;

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(uid, { description: pc.localDescription!.toJSON(), kinds: this.localKinds() });
      } catch (e) {
        log("warn", `negotiation with ${uid} failed: ${e}`);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(uid, { candidate: candidate.toJSON() });
    };
    pc.ontrack = (ev) => this.onTrack(peer, ev);
    pc.ondatachannel = (ev) => {
      if (ev.channel.label === "ctrl") this.setupCtrl(peer, ev.channel);
    };
    pc.onconnectionstatechange = () => {
      this.updateStats(uid, { state: pc.connectionState });
      if (pc.connectionState === "failed") {
        log("warn", `media connection to ${uid} failed, restarting ICE`);
        pc.restartIce();
      }
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "disconnected") {
        if (peer.restartTimer) clearTimeout(peer.restartTimer);
        peer.restartTimer = setTimeout(() => {
          if (pc.iceConnectionState === "disconnected") pc.restartIce();
        }, 4000);
      }
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") void this.tuneSenders(peer);
    };
    if (initiator) {
      this.attachLocal(peer);
      this.setupCtrl(peer, pc.createDataChannel("ctrl", { ordered: true }));
    }
    this.updateStats(uid, { state: "new" });
    return peer;
  }

  /** Low-latency throttle for outgoing mouse moves while controlling. */
  private moveSentAt = 0;
  private pendingMove: { x: number; y: number } | null = null;

  private setupCtrl(peer: Peer, ch: RTCDataChannel) {
    peer.ctrl = ch;
    ch.onmessage = (e) => {
      try {
        this.onCtrl(peer.uid, JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    ch.onclose = () => {
      if (this.controlledBy.value === peer.uid) this.setControlledBy(null);
      if (this.controlling.value === peer.uid) this.controlling.value = null;
    };
  }

  private sendCtrl(uid: number, obj: unknown) {
    const ch = this.peers.get(uid)?.ctrl;
    if (ch && ch.readyState === "open") ch.send(JSON.stringify(obj));
  }

  /** Host side: enables/disables OS input injection (desktop app only). */
  private setControlledBy(uid: number | null) {
    this.controlledBy.value = uid;
    if (isTauri) void tauriInvoke("remote_set_allowed", { allowed: uid !== null }).catch(() => {});
  }

  private onCtrl(uid: number, msg: { t: string; pw?: string; c?: unknown[] }) {
    if (msg.t === "req") {
      // Someone asks to control my computer.
      if (!this.remoteAllowed.value || this.controlledBy.value !== null || (this.remotePassword.value && msg.pw !== this.remotePassword.value)) {
        this.sendCtrl(uid, { t: "deny" });
        return;
      }
      this.setControlledBy(uid);
      this.sendCtrl(uid, { t: "grant" });
      toast(t("rc2.nowControlling", { name: this.server.memberName(uid) }), t("rc2.revokeHint"), "warn", 7000);
    } else if (msg.t === "grant") {
      this.controlling.value = uid;
      toast(t("rc2.granted", { name: this.server.memberName(uid) }), t("rc2.grantedHint"), "ok", 6000);
    } else if (msg.t === "deny") {
      this.controlling.value = null;
      toast(t("rc2.denied"), undefined, "warn", 4000);
    } else if (msg.t === "i") {
      // Input from the controller – only if it is the one I granted.
      if (this.controlledBy.value === uid && Array.isArray(msg.c) && isTauri) void tauriInvoke("remote_inject", { cmds: msg.c }).catch(() => {});
    } else if (msg.t === "end") {
      if (this.controlledBy.value === uid) this.setControlledBy(null);
    } else if (msg.t === "rev") {
      if (this.controlling.value === uid) {
        this.controlling.value = null;
        toast(t("rc2.revoked", { name: this.server.memberName(uid) }), undefined, "warn", 4000);
      }
    }
  }

  /** Host: turn remote control on/off and set the password. */
  setRemote(on: boolean, pw?: string) {
    this.remoteAllowed.value = on;
    if (pw !== undefined) this.remotePassword.value = pw;
    if (!on && this.controlledBy.value !== null) {
      this.sendCtrl(this.controlledBy.value, { t: "rev" });
      this.setControlledBy(null);
    }
  }

  /** Host: kick the current controller. */
  revokeControl() {
    if (this.controlledBy.value !== null) {
      this.sendCtrl(this.controlledBy.value, { t: "rev" });
      this.setControlledBy(null);
    }
  }

  /** Viewer: ask to control `uid`'s computer with a password. */
  requestControl(uid: number, pw: string) {
    this.sendCtrl(uid, { t: "req", pw });
  }

  /** Viewer: stop controlling and tell the host. */
  releaseControl() {
    const uid = this.controlling.value;
    if (uid !== null) {
      this.sendCtrl(uid, { t: "end" });
      this.controlling.value = null;
    }
  }

  /** Viewer: send a batch of input actions to the controlled host. */
  sendInput(cmds: unknown[]) {
    const uid = this.controlling.value;
    if (uid !== null && cmds.length) this.sendCtrl(uid, { t: "i", c: cmds });
  }

  /** Viewer: throttled absolute mouse move (coalesced to ~60/s). */
  sendMove(x: number, y: number) {
    this.pendingMove = { x, y };
    const now = performance.now();
    if (now - this.moveSentAt >= 16) {
      this.moveSentAt = now;
      const m = this.pendingMove;
      this.pendingMove = null;
      this.sendInput([{ t: "m", x: m.x, y: m.y }]);
    }
  }

  private closePeer(uid: number) {
    const p = this.peers.get(uid);
    if (!p) return;
    p.close();
    this.peers.delete(uid);
    this.dropRemote(uid, "screen");
    this.dropRemote(uid, "camera");
    const stats = new Map(this.stats.value);
    stats.delete(uid);
    this.stats.value = stats;
  }

  private async onSignal(from: number, data: SignalData) {
    let peer = this.peers.get(from);
    if (!peer) {
      if (!data.description || data.description.type !== "offer") return;
      peer = this.createPeer(from, false);
    }
    const pc = peer.pc;
    if (data.kinds) for (const [id, k] of Object.entries(data.kinds)) peer.remoteKinds.set(id, k);
    try {
      if (data.description) {
        const d = data.description;
        const collision = d.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;
        await pc.setRemoteDescription(d);
        if (d.type === "offer") {
          if (peer.pendingLocal) {
            peer.pendingLocal = false;
            this.attachLocal(peer);
          }
          await pc.setLocalDescription();
          this.signal(from, { description: pc.localDescription!.toJSON(), kinds: this.localKinds() });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (e) {
          if (!peer.ignoreOffer) throw e;
        }
      }
    } catch (e) {
      log("warn", `signal from ${from} failed: ${e}`);
    }
  }

  private onTrack(peer: Peer, ev: RTCTrackEvent) {
    const stream = ev.streams[0];
    const kind = (stream && peer.remoteKinds.get(stream.id)) ?? (ev.track.kind === "audio" ? "mic" : "camera");
    const uid = peer.uid;
    if (ev.track.kind === "audio") {
      // Screen and webcam carry system audio; only the mic counts for "speaking".
      const el = kind === "mic" ? peer.micEl : peer.screenAudioEl;
      if (kind === "mic") peer.micTrackId = ev.track.id;
      el.srcObject = stream ?? new MediaStream([ev.track]);
      this.applyOutput(peer);
      el.play().catch(() => toast(t("voice.audioBlocked"), t("voice.audioBlockedBody"), "warn"));
      return;
    }
    const target = kind === "screen" ? this.screens : this.cameras;
    const s = stream ?? new MediaStream([ev.track]);
    const map = new Map(target.value);
    map.set(uid, s);
    target.value = map;
    const drop = () => {
      if (!s.getVideoTracks().some((t) => t.readyState === "live")) this.dropRemote(uid, kind === "screen" ? "screen" : "camera");
    };
    s.onremovetrack = drop;
    ev.track.onended = drop;
  }

  private dropRemote(uid: number, kind: "screen" | "camera") {
    const target = kind === "screen" ? this.screens : this.cameras;
    if (!target.value.has(uid)) return;
    const map = new Map(target.value);
    map.delete(uid);
    target.value = map;
  }

  private onServerEvent(store: ServerStore, ev: string, d: any) {
    if (store !== this.server || this.state.value === "ended") return;
    if (ev === "rtc.signal") void this.onSignal(d.from, d.data);
    else if (ev === "voice.state" && d.channel_id === this.channelId) {
      if (d.user_id === this.selfId) {
        if (d.left) {
          toast(t("voice.endedByServer"), t("voice.endedByServerBody"), "warn");
          void endVoice();
        } else this.applyModeration(d);
        return;
      }
      if (d.left) {
        if (this.present.delete(d.user_id)) play("userLeave");
        this.closePeer(d.user_id);
      } else {
        if (!this.present.has(d.user_id)) {
          this.present.add(d.user_id);
          play("userJoin");
        }
        // Only render streams the server says are active (honest-client enforcement).
        if (!d.screen) this.dropRemote(d.user_id, "screen");
        if (!d.video) this.dropRemote(d.user_id, "camera");
      }
    } else if (ev === "voice.state" && d.user_id === this.selfId && !d.left && d.channel_id !== this.channelId) {
      // Joined elsewhere from another device.
      void endVoice();
    } else if (ev === "voice.moved") {
      // A moderator moved us (or disconnected us when channel_id is null).
      const to: number | null = d.channel_id ?? null;
      const by = this.server.memberName(d.by);
      void endVoice().then(() => {
        if (to !== null) {
          toast(t("voice.movedTitle"), t("voice.movedBody", { name: by, channel: this.server.channel(to)?.name ?? "" }), "info");
          void joinVoice(this.server, to);
        } else toast(t("voice.kickedTitle"), t("voice.kickedBody", { name: by }), "warn");
      });
    } else if (ev === "voice.reaction" && d.channel_id === this.channelId) {
      if (settings.value.localMute[`${this.server.id}:${d.user_id}`]) return;
      const r = { id: ++this.reactionSeq, uid: d.user_id as number, emoji: String(d.emoji), x: 20 + Math.random() * 60 };
      this.reactions.value = [...this.reactions.value.slice(-24), r];
      setTimeout(() => (this.reactions.value = this.reactions.value.filter((x) => x.id !== r.id)), 3200);
    } else if (ev === "voice.sound" && d.channel_id === this.channelId) {
      const st = settings.value;
      // Own sounds are played locally on click, so skip the echo from the server.
      if (d.user_id !== this.selfId && !this.deafened.value && !st.localMute[`${this.server.id}:${d.user_id}`]) playBoard(d.sound);
    } else if (ev === "ready" && d.reconnect) {
      this.state.value = "reconnecting";
      this.joinChannel(true).catch((e) => {
        toast(t("voice.lost"), errorText(e), "error");
        void endVoice();
      });
    }
  }

  // ------------------------------------------------------------- controls

  private globalKey: string | null = null;

  /** Registers the system-wide push-to-talk key (desktop app only). */
  async registerGlobalPtt() {
    await this.unregisterGlobalPtt();
    const st = settings.value;
    if (!isTauri || !st.pushToTalk || !st.globalPtt || !st.globalPttKey) return;
    try {
      const gs = await import("@tauri-apps/plugin-global-shortcut");
      await gs.register(st.globalPttKey, (ev) => {
        this.pttDown.value = ev.state === "Pressed";
        this.applyMicEnabled();
      });
      this.globalKey = st.globalPttKey;
    } catch (e) {
      toast(t("voice.globalPttFailed"), String(e), "warn");
    }
  }

  async unregisterGlobalPtt() {
    if (!this.globalKey) return;
    const key = this.globalKey;
    this.globalKey = null;
    try {
      const gs = await import("@tauri-apps/plugin-global-shortcut");
      await gs.unregister(key);
    } catch {
      /* ignore */
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const st = settings.value;
    if (!st.pushToTalk || e.code !== st.pttKey || e.repeat) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    this.pttDown.value = down;
    this.applyMicEnabled();
  }

  /** The microphone track only carries audio while the user transmits. */
  transmitting() {
    const st = settings.value;
    return this.hasMic.value && !this.muted.value && !this.deafened.value && !this.suppressed.value && !this.serverMuted.value && (!st.pushToTalk || this.pttDown.value);
  }

  /** Server mute / deafen and lost speaking rights apply immediately. */
  private applyModeration(d: VoiceMember) {
    const wasDeaf = this.serverDeafened.value;
    if (d.server_muted && !this.serverMuted.value) toast(t("voice.serverMutedTitle"), t("voice.serverMutedBody"), "warn");
    this.serverMuted.value = !!d.server_muted;
    this.serverDeafened.value = !!d.server_deafened;
    this.suppressed.value = d.suppressed;
    if (d.server_deafened && !this.deafened.value) {
      this.deafened.value = true;
      for (const p of this.peers.values()) this.applyOutput(p);
    } else if (!d.server_deafened && wasDeaf && this.deafened.value && !d.deafened) {
      this.deafened.value = false;
      for (const p of this.peers.values()) this.applyOutput(p);
    }
    this.applyMicEnabled();
  }

  /** Sends a floating reaction to everyone in the call. */
  async react(emoji: string) {
    await this.server.rpc("voice.react", { emoji });
  }

  handRaised() {
    return !!this.server.voice.value.get(this.selfId)?.hand;
  }

  async setHand(up: boolean) {
    await this.server.rpc("voice.update", { hand: up });
  }

  /** Plays a soundboard sound for everyone in the channel. */
  async playSound(id: string) {
    await this.server.rpc("voice.sound", { sound: id });
  }

  applyMicEnabled() {
    const on = this.transmitting();
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  async setMuted(m: boolean) {
    if (!m && this.serverMuted.value) return toast(t("voice.serverMutedTitle"), t("voice.serverMutedBody"), "warn");
    if (m !== this.muted.value) play(m ? "mute" : "unmute");
    this.muted.value = m;
    this.applyMicEnabled();
    await this.server.rpc("voice.update", { muted: m }).catch(() => {});
  }

  async setDeafened(d: boolean) {
    if (!d && this.serverDeafened.value) return toast(t("voice.serverDeafenedTitle"), t("voice.serverDeafenedBody"), "warn");
    if (d !== this.deafened.value) play(d ? "deafen" : "undeafen");
    this.deafened.value = d;
    for (const p of this.peers.values()) this.applyOutput(p);
    this.applyMicEnabled();
    await this.server.rpc("voice.update", { deafened: d, muted: this.muted.value || d }).catch(() => {});
  }

  /** Applies output device, deafen and per-user volume to a peer's audio. */
  applyOutput(peer: Peer) {
    const st = settings.value;
    const key = `${this.server.id}:${peer.uid}`;
    const vol = st.userVolume[key] ?? 1;
    for (const el of [peer.micEl, peer.screenAudioEl]) {
      el.muted = this.deafened.value || !!st.localMute[key];
      el.volume = Math.max(0, Math.min(1, vol));
      const sink = (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      if (sink && st.outputDevice) sink.call(el, st.outputDevice).catch(() => {});
    }
  }

  refreshOutputs() {
    for (const p of this.peers.values()) this.applyOutput(p);
  }

  /** Switches the microphone without renegotiation (replaceTrack). */
  async changeInputDevice() {
    const old = this.mic;
    const oldRaw = this.rawMic;
    await this.openMic();
    const track = this.mic?.getAudioTracks()[0] ?? null;
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === "audio" && old?.getTracks().includes(s.track));
      if (sender) await sender.replaceTrack(track);
      else if (track && this.mic) p.pc.addTrack(track, this.mic);
    }
    old?.getTracks().forEach((t) => t.stop());
    if (oldRaw !== this.rawMic) oldRaw?.getTracks().forEach((t) => t.stop());
  }

  // ------------------------------------------------------------- screen & camera

  /** `surface` preselects the tab in the system picker: whole screen or a window. */
  async startScreen(surface: "monitor" | "window" = "monitor") {
    if (this.sharingScreen.value) return;
    const prof = screenProfile();
    const st = settings.value;
    let stream: MediaStream;
    captureBar(true);
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: surface, frameRate: { ideal: prof.fps, max: prof.fps }, width: { max: prof.width }, height: { max: prof.height } } as MediaTrackConstraints,
        // restrictOwnAudio: keep NexUs' own output (the others' voices) out of
        // the shared system audio, so nobody hears themselves echoed back.
        audio: st.screenAudio ? SYSTEM_AUDIO : false,
        systemAudio: st.screenAudio ? "include" : "exclude",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      captureBar(false);
      const name = (e as DOMException)?.name;
      if (name !== "NotAllowedError" && name !== "AbortError") toast(t("voice.screenFailed"), String(e), "error");
      return;
    }
    try {
      await this.server.rpc("voice.update", { screen: true });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      captureBar(false);
      toast(t("voice.screenDenied"), errorText(e), "error");
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = prof.motion ? "motion" : "detail";
      video.onended = () => void this.stopScreen();
    }
    // Remote control is only offered for a whole-screen share, so the controller
    // can see the entire desktop they are driving (not just one window).
    const surf = (video?.getSettings() as MediaTrackSettings & { displaySurface?: string })?.displaySurface;
    this.screenIsMonitor.value = surf ? surf === "monitor" : surface === "monitor";
    if (!this.screenIsMonitor.value && this.remoteAllowed.value) this.setRemote(false);
    this.screen = stream;
    this.sharingScreen.value = true;
    play("streamStart");
    this.screenHasAudio.value = stream.getAudioTracks().length > 0;
    if (st.screenAudio && !this.screenHasAudio.value) {
      toast(
        t("voice.noSystemAudio"),
        t("voice.noSystemAudioBody"),
        "warn",
        10000,
      );
    }
    const map = new Map(this.screens.value);
    map.set(this.selfId, stream);
    this.screens.value = map;
    for (const p of this.peers.values()) for (const t of stream.getTracks()) p.pc.addTrack(t, stream);
  }

  async stopScreen() {
    if (!this.screen) return;
    if (this.remoteAllowed.value) this.setRemote(false);
    const s = this.screen;
    this.screen = null;
    this.sharingScreen.value = false;
    this.screenIsMonitor.value = false;
    captureBar(false);
    play("streamStop");
    this.screenHasAudio.value = null;
    for (const p of this.peers.values()) {
      for (const sender of p.pc.getSenders()) if (sender.track && s.getTracks().includes(sender.track)) p.pc.removeTrack(sender);
    }
    s.getTracks().forEach((t) => t.stop());
    this.dropRemote(this.selfId, "screen");
    await this.server.rpc("voice.update", { screen: false }).catch(() => {});
  }

  /** Re-applies the current quality profile to a running screen share. */
  async applyScreenProfile() {
    const prof = screenProfile();
    const v = this.screen?.getVideoTracks()[0];
    if (!v) return;
    v.contentHint = prof.motion ? "motion" : "detail";
    await v.applyConstraints({ frameRate: { ideal: prof.fps, max: prof.fps }, width: { max: prof.width }, height: { max: prof.height } }).catch(() => {});
    for (const p of this.peers.values()) await this.tuneSenders(p);
  }

  private async tuneSenders(peer: Peer) {
    const prof = screenProfile();
    for (const sender of peer.pc.getSenders()) {
      const t = sender.track;
      if (!t || t.kind !== "video") continue;
      const isScreen = this.screen?.getTracks().includes(t);
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      const enc = params.encodings[0];
      if (isScreen) {
        enc.maxBitrate = prof.kbps * 1000;
        enc.maxFramerate = prof.fps;
        (params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
          prof.motion ? "maintain-framerate" : "maintain-resolution";
      } else {
        enc.maxBitrate = 600_000;
        enc.maxFramerate = 24;
      }
      await sender.setParameters(params).catch(() => {});
    }
  }

  async startCamera() {
    if (this.cameraOn.value) return;
    const st = settings.value;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: st.videoDevice ? { exact: st.videoDevice } : undefined,
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      toast(
        t("voice.camUnavailable"),
        name === "NotFoundError" ? t("voice.camMissing") : name === "NotAllowedError" ? t("voice.camDenied") : String(e),
        "error",
      );
      return;
    }
    try {
      await this.server.rpc("voice.update", { video: true });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      toast(t("voice.camNotAllowed"), errorText(e), "error");
      return;
    }
    // System audio with the webcam (optional): the screen picker hands it over,
    // its picture is dropped right away.
    if (st.cameraAudio && !(this.sharingScreen.value && this.screenHasAudio.value)) {
      captureBar(true);
      try {
        const sys = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: "monitor", width: { max: 320 }, frameRate: { max: 1 } } as MediaTrackConstraints,
          audio: SYSTEM_AUDIO,
          systemAudio: "include",
          selfBrowserSurface: "exclude",
          monitorTypeSurfaces: "include",
        } as DisplayMediaStreamOptions);
        sys.getVideoTracks().forEach((tr) => tr.stop());
        const audio = sys.getAudioTracks()[0];
        if (audio) {
          stream.addTrack(audio);
          this.cameraAudioTrack = audio;
        } else captureBar(false);
        this.cameraHasAudio.value = !!audio;
      } catch {
        captureBar(false);
        this.cameraHasAudio.value = false;
      }
    }
    this.camera = stream;
    this.cameraOn.value = true;
    stream.getVideoTracks()[0].onended = () => void this.stopCamera();
    const map = new Map(this.cameras.value);
    map.set(this.selfId, stream);
    this.cameras.value = map;
    for (const p of this.peers.values()) for (const t of stream.getTracks()) p.pc.addTrack(t, stream);
  }

  async stopCamera() {
    if (!this.camera) return;
    const s = this.camera;
    this.camera = null;
    this.cameraOn.value = false;
    if (this.cameraAudioTrack) {
      this.cameraAudioTrack = null;
      captureBar(false);
    }
    this.cameraHasAudio.value = false;
    for (const p of this.peers.values()) {
      for (const sender of p.pc.getSenders()) if (sender.track && s.getTracks().includes(sender.track)) p.pc.removeTrack(sender);
    }
    s.getTracks().forEach((t) => t.stop());
    this.dropRemote(this.selfId, "camera");
    await this.server.rpc("voice.update", { video: false }).catch(() => {});
  }

  // ------------------------------------------------------------- monitoring

  private pollSpeaking() {
    const next = new Set<number>();
    if (this.analyser && this.transmitting()) {
      const buf = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      this.micLevel.value = Math.min(1, rms * 4);
      if (rms > 0.02) next.add(this.selfId);
    } else this.micLevel.value = 0;
    for (const p of this.peers.values()) {
      const r = p.pc.getReceivers().find((x) => x.track.id === p.micTrackId);
      const lvl = r?.getSynchronizationSources?.()[0]?.audioLevel ?? 0;
      if (lvl > 0.02) next.add(p.uid);
    }
    const prev = this.speaking.value;
    if (prev.size !== next.size || [...next].some((x) => !prev.has(x))) this.speaking.value = next;
  }

  private updateStats(uid: number, patch: Partial<PeerStats>) {
    const map = new Map(this.stats.value);
    const cur = map.get(uid) ?? { state: "new", rtt: null, loss: null, relay: false, quality: "connecting" };
    const n = { ...cur, ...patch } as PeerStats;
    n.quality =
      n.state !== "connected"
        ? n.state === "failed" ? "bad" : "connecting"
        : (n.rtt ?? 0) > 300 || (n.loss ?? 0) > 8 ? "bad" : (n.rtt ?? 0) > 150 || (n.loss ?? 0) > 2 ? "ok" : "good";
    map.set(uid, n);
    this.stats.value = map;
  }

  private async pollStats() {
    for (const p of this.peers.values()) {
      if (p.pc.connectionState !== "connected") continue;
      try {
        const report = await p.pc.getStats();
        let rtt: number | null = null;
        let relay = false;
        let lost = 0;
        let recv = 0;
        let pairId: string | undefined;
        report.forEach((s: any) => {
          if (s.type === "transport" && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
        });
        report.forEach((s: any) => {
          if (s.type === "candidate-pair" && (s.id === pairId || (!pairId && s.nominated && s.state === "succeeded"))) {
            if (typeof s.currentRoundTripTime === "number") rtt = Math.round(s.currentRoundTripTime * 1000);
            const local = report.get(s.localCandidateId) as any;
            const remote = report.get(s.remoteCandidateId) as any;
            relay = local?.candidateType === "relay" || remote?.candidateType === "relay";
          }
          if (s.type === "inbound-rtp" && s.kind === "audio") {
            lost += s.packetsLost ?? 0;
            recv += s.packetsReceived ?? 0;
          }
        });
        const dLost = Math.max(0, lost - p.lostPrev);
        const dRecv = Math.max(0, recv - p.recvPrev);
        p.lostPrev = lost;
        p.recvPrev = recv;
        const loss = dLost + dRecv > 0 ? Math.round((dLost / (dLost + dRecv)) * 1000) / 10 : 0;
        this.updateStats(p.uid, { rtt, relay, loss, state: p.pc.connectionState });
      } catch {
        /* peer closed meanwhile */
      }
    }
  }

  /** Aggregated quality for the status display. */
  overallQuality(): PeerStats["quality"] | "alone" {
    const all = [...this.stats.value.values()];
    if (!all.length) return "alone";
    if (all.some((s) => s.quality === "bad")) return "bad";
    if (all.some((s) => s.quality === "connecting")) return "connecting";
    if (all.some((s) => s.quality === "ok")) return "ok";
    return "good";
  }

  peerIds() {
    return [...this.peers.keys()];
  }
}

// ------------------------------------------------------------- global session

export const voice = signal<VoiceSession | null>(null);
export const voiceBusy = signal(false);

export async function joinVoice(server: ServerStore, channelId: number) {
  if (voiceBusy.value) return;
  const cur = voice.value;
  if (cur && cur.server === server && cur.channelId === channelId) return;
  voiceBusy.value = true;
  try {
    if (cur) await endVoice();
    voice.value = await VoiceSession.join(server, channelId);
    play("join");
  } catch (e) {
    toast(t("voice.joinFailed"), errorText(e), "error");
  } finally {
    voiceBusy.value = false;
  }
}

export async function endVoice() {
  const cur = voice.value;
  voice.value = null;
  if (cur) play("leave");
  await cur?.leave();
}

// Leave voice cleanly when the window closes.
window.addEventListener("beforeunload", () => {
  void voice.value?.leave();
});

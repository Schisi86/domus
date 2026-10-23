// Voice/video/screen session: a WebRTC mesh between the participants of one
// voice channel. The server only relays signaling (SDP/ICE); media flows
// directly between clients or, if configured, through the TURN relay.
//
// Negotiation follows the "perfect negotiation" pattern so both sides can add
// or remove tracks (screen, camera) at any time without glare problems.

import { signal } from "@preact/signals";
import { settings, toast, voiceHooks, type ScreenOpts, type ScreenRes } from "../state/app";
import type { ServerStore } from "../state/server";
import type { VoiceMember } from "../types";
import { errorText, t } from "../i18n";
import { isTauri, log } from "../platform";
import { normalizeAddress } from "../net/transport";
import { play } from "../sound";

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

  constructor(public uid: number, public polite: boolean, config: RTCConfiguration, initiator: boolean) {
    this.pc = new RTCPeerConnection(config);
    this.pendingLocal = !initiator;
    this.micEl.autoplay = true;
    this.screenAudioEl.autoplay = true;
  }

  close() {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.pc.close();
    for (const el of [this.micEl, this.screenAudioEl]) {
      el.pause();
      el.srcObject = null;
    }
  }
}

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
  cameraOn = signal(false);
  suppressed = signal(false);

  private mic: MediaStream | null = null;
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
      this.mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined,
          echoCancellation: st.echoCancellation,
          noiseSuppression: st.noiseSuppression,
          autoGainControl: st.autoGainControl,
          channelCount: 1,
        },
        video: false,
      });
      this.hasMic.value = true;
      this.setupAnalyser();
    } catch (e) {
      this.mic = null;
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

  private setupAnalyser() {
    if (!this.mic) return;
    try {
      this.audioCtx?.close();
      this.audioCtx = new AudioContext();
      const src = this.audioCtx.createMediaStreamSource(this.mic);
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 512;
      src.connect(this.analyser);
    } catch {
      this.analyser = null;
    }
  }

  private async joinChannel(rejoin: boolean) {
    const r = await this.server.rpc<{ participants: VoiceMember[]; self: VoiceMember }>("voice.join", {
      channel_id: this.channelId,
      muted: this.muted.value || !this.hasMic.value,
      deafened: this.deafened.value,
    });
    this.suppressed.value = r.self.suppressed;
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
    this.state.value = "ended";
    voiceHooks.delete(this.hook);
    window.removeEventListener("keydown", this.keyDown);
    window.removeEventListener("keyup", this.keyUp);
    void this.unregisterGlobalPtt();
    this.loops.forEach(clearInterval);
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    for (const s of [this.mic, this.screen, this.camera]) s?.getTracks().forEach((t) => t.stop());
    this.mic = this.screen = this.camera = null;
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
    if (ice?.turn) list.push({ urls: `turn:${h}:${ice.turn.port}?transport=udp`, username: ice.turn.username, credential: ice.turn.credential });
    for (const s of ice?.servers ?? []) list.push({ urls: s.urls, username: s.username, credential: s.credential });
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
    if (this.camera) for (const t of this.camera.getVideoTracks()) pc.addTrack(t, this.camera);
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
    if (initiator) this.attachLocal(peer);
    this.updateStats(uid, { state: "new" });
    return peer;
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
      const el = kind === "screen" ? peer.screenAudioEl : peer.micEl;
      if (kind !== "screen") peer.micTrackId = ev.track.id;
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
        }
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
    return this.hasMic.value && !this.muted.value && !this.deafened.value && !this.suppressed.value && (!st.pushToTalk || this.pttDown.value);
  }

  applyMicEnabled() {
    const on = this.transmitting();
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  async setMuted(m: boolean) {
    if (m !== this.muted.value) play(m ? "mute" : "unmute");
    this.muted.value = m;
    this.applyMicEnabled();
    await this.server.rpc("voice.update", { muted: m }).catch(() => {});
  }

  async setDeafened(d: boolean) {
    if (d !== this.deafened.value) play(d ? "deafen" : "undeafen");
    this.deafened.value = d;
    for (const p of this.peers.values()) this.applyOutput(p);
    this.applyMicEnabled();
    await this.server.rpc("voice.update", { deafened: d, muted: this.muted.value || d }).catch(() => {});
  }

  /** Applies output device, deafen and per-user volume to a peer's audio. */
  applyOutput(peer: Peer) {
    const st = settings.value;
    const vol = st.userVolume[`${this.server.id}:${peer.uid}`] ?? 1;
    for (const el of [peer.micEl, peer.screenAudioEl]) {
      el.muted = this.deafened.value;
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
    await this.openMic();
    const track = this.mic?.getAudioTracks()[0] ?? null;
    for (const p of this.peers.values()) {
      const sender = p.pc.getSenders().find((s) => s.track?.kind === "audio" && old?.getTracks().includes(s.track));
      if (sender) await sender.replaceTrack(track);
      else if (track && this.mic) p.pc.addTrack(track, this.mic);
    }
    old?.getTracks().forEach((t) => t.stop());
  }

  // ------------------------------------------------------------- screen & camera

  async startScreen() {
    if (this.sharingScreen.value) return;
    const prof = screenProfile();
    const st = settings.value;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: prof.fps, max: prof.fps }, width: { max: prof.width }, height: { max: prof.height } },
        audio: st.screenAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
        systemAudio: st.screenAudio ? "include" : "exclude",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        monitorTypeSurfaces: "include",
      } as DisplayMediaStreamOptions);
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name !== "NotAllowedError" && name !== "AbortError") toast(t("voice.screenFailed"), String(e), "error");
      return;
    }
    try {
      await this.server.rpc("voice.update", { screen: true });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      toast(t("voice.screenDenied"), errorText(e), "error");
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (video) {
      video.contentHint = prof.motion ? "motion" : "detail";
      video.onended = () => void this.stopScreen();
    }
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
    const s = this.screen;
    this.screen = null;
    this.sharingScreen.value = false;
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
    this.camera = stream;
    this.cameraOn.value = true;
    stream.getVideoTracks()[0].onended = () => void this.stopCamera();
    const map = new Map(this.cameras.value);
    map.set(this.selfId, stream);
    this.cameras.value = map;
    for (const p of this.peers.values()) for (const t of stream.getVideoTracks()) p.pc.addTrack(t, stream);
  }

  async stopCamera() {
    if (!this.camera) return;
    const s = this.camera;
    this.camera = null;
    this.cameraOn.value = false;
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

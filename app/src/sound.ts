// Subtle interface sounds, synthesized with WebAudio (no audio files shipped,
// no licences to track). A soft bell voice – sine plus a quiet overtone,
// gentle low-pass and a little room – keeps every cue short and friendly.

import { settings } from "./state/app";

export type Cue =
  | "join"
  | "leave"
  | "userJoin"
  | "userLeave"
  | "switch"
  | "mute"
  | "unmute"
  | "deafen"
  | "undeafen"
  | "streamStart"
  | "streamStop"
  | "message"
  | "call";

let ctx: AudioContext | null = null;
let bus: GainNode | null = null;
let sinkId = "";
const lastPlayed = new Map<Cue, number>();

function engine() {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: "interactive" });
    // Master bus → low-pass (takes the edge off) → output, plus a short echo as "room".
    bus = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 3800;
    lp.Q.value = 0.4;
    const delay = ctx.createDelay(0.5);
    delay.delayTime.value = 0.11;
    const fb = ctx.createGain();
    fb.gain.value = 0.18;
    const wet = ctx.createGain();
    wet.gain.value = 0.22;
    bus.connect(lp);
    lp.connect(ctx.destination);
    lp.connect(delay);
    delay.connect(fb).connect(delay);
    delay.connect(wet).connect(ctx.destination);
  }
  // Same output device as voice chat, where the browser engine supports it.
  const out = settings.value.outputDevice;
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (c.setSinkId && out !== sinkId) {
    sinkId = out;
    void c.setSinkId(out || "").catch(() => {});
  }
  if (ctx.state === "suspended") void ctx.resume();
  return { ctx, bus: bus! };
}

/** One soft bell note: frequency glide optional, fast attack, natural decay. */
function bell(at: number, freq: number, dur: number, gain: number, glideTo?: number) {
  const { ctx, bus } = engine();
  const t0 = ctx.currentTime + at;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  env.connect(bus);
  for (const [mult, level] of [[1, 1], [2, 0.18], [3.01, 0.05]] as const) {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(freq * mult, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo * mult, t0 + Math.min(0.12, dur * 0.6));
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(env);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }
}

/** A tiny, airy tick for frequent actions (channel switch). */
function tick(at: number, freq: number, gain: number) {
  const { ctx, bus } = engine();
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(freq, t0);
  o.frequency.exponentialRampToValueAtTime(freq * 0.7, t0 + 0.05);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
  o.connect(g).connect(bus);
  o.start(t0);
  o.stop(t0 + 0.1);
}

// Notes (Hz)
const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880, B5 = 987.77, C6 = 1046.5, E6 = 1318.5;

const CUES: Record<Cue, (v: number) => void> = {
  join: (v) => { bell(0, C5, 0.45, 0.16 * v); bell(0.085, G5, 0.6, 0.14 * v); },
  leave: (v) => { bell(0, G5, 0.4, 0.13 * v); bell(0.085, C5, 0.55, 0.14 * v); },
  userJoin: (v) => bell(0, E5, 0.32, 0.11 * v, A5),
  userLeave: (v) => bell(0, A5, 0.32, 0.1 * v, E5),
  switch: (v) => tick(0, 2200, 0.035 * v),
  mute: (v) => { tick(0, 1400, 0.06 * v); tick(0.045, 950, 0.05 * v); },
  unmute: (v) => { tick(0, 950, 0.05 * v); tick(0.045, 1400, 0.06 * v); },
  deafen: (v) => bell(0, G5, 0.22, 0.08 * v, C5),
  undeafen: (v) => bell(0, C5, 0.22, 0.08 * v, G5),
  streamStart: (v) => { bell(0, C5, 0.3, 0.09 * v); bell(0.07, E5, 0.3, 0.09 * v); bell(0.14, G5, 0.5, 0.1 * v); },
  streamStop: (v) => { bell(0, G5, 0.3, 0.09 * v); bell(0.07, E5, 0.3, 0.08 * v); bell(0.14, C5, 0.45, 0.09 * v); },
  message: (v) => { bell(0, A5, 0.35, 0.1 * v); bell(0.08, E6, 0.45, 0.07 * v); },
  call: (v) => { bell(0, E5, 0.4, 0.12 * v); bell(0.1, G5, 0.4, 0.12 * v); bell(0.2, B5, 0.6, 0.12 * v); bell(0.32, C6, 0.6, 0.06 * v); },
};

/** Minimum gap per cue, so rapid repeats (e.g. arrow-key channel hopping) stay quiet. */
const GAP: Partial<Record<Cue, number>> = { switch: 80, message: 1500, call: 1500, userJoin: 250, userLeave: 250 };

/** Plays an interface cue if UI sounds are on (message/call follow the notification setting). */
export function play(cue: Cue, force = false) {
  const s = settings.value;
  const isNotify = cue === "message" || cue === "call";
  if (!force && (isNotify ? !(s.notifications && s.notifySound) : !s.uiSounds)) return;
  const now = Date.now();
  if (!force && now - (lastPlayed.get(cue) ?? 0) < (GAP[cue] ?? 120)) return;
  lastPlayed.set(cue, now);
  try {
    CUES[cue](Math.max(0, Math.min(1, s.uiVolume)) * 1.6);
  } catch {
    /* audio unavailable */
  }
}

/** Kept for the notification code paths. */
export function playChime(call = false) {
  play(call ? "call" : "message");
}

/** Short demo of the main cues for the settings dialog. */
export function playDemo() {
  const seq: Cue[] = ["join", "userJoin", "switch", "mute", "unmute", "userLeave", "leave"];
  seq.forEach((c, i) => setTimeout(() => play(c, true), i * 520));
}

// ------------------------------------------------------------- soundboard
// Short fun sounds everyone in a voice channel hears (like Discord's
// soundboard). Also synthesized: nothing to download, nothing to license.

export const SOUNDBOARD = [
  { id: "airhorn", emoji: "📯" },
  { id: "tada", emoji: "🎉" },
  { id: "rimshot", emoji: "🥁" },
  { id: "applause", emoji: "👏" },
  { id: "sad", emoji: "🎺" },
  { id: "crickets", emoji: "🦗" },
  { id: "bell", emoji: "🔔" },
  { id: "boing", emoji: "🌀" },
] as const;
export type BoardSound = (typeof SOUNDBOARD)[number]["id"];

function boardOut(volume: number) {
  const { ctx } = engine();
  const g = ctx.createGain();
  g.gain.value = volume;
  g.connect(ctx.destination);
  return { ctx, out: g };
}

function voice(ctx: AudioContext, out: AudioNode, type: OscillatorType, freq: number, t0: number, dur: number, gain: number, cutoff = 2400) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = cutoff;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(gain, t0 + 0.02);
  env.gain.setValueAtTime(gain, t0 + Math.max(0.03, dur - 0.08));
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(lp).connect(env).connect(out);
  o.start(t0);
  o.stop(t0 + dur + 0.05);
  return o;
}

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function noiseHit(ctx: AudioContext, out: AudioNode, t0: number, dur: number, gain: number, type: BiquadFilterType, freq: number, q = 1) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, dur + 0.05);
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(env).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

function tom(ctx: AudioContext, out: AudioNode, t0: number, from: number, gain: number) {
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(from, t0);
  o.frequency.exponentialRampToValueAtTime(from * 0.45, t0 + 0.25);
  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.3);
  o.connect(env).connect(out);
  o.start(t0);
  o.stop(t0 + 0.35);
}

const BOARD: Record<BoardSound, (ctx: AudioContext, out: AudioNode) => void> = {
  airhorn: (ctx, out) => {
    const t = ctx.currentTime;
    [[0, 0.16], [0.2, 0.16], [0.4, 0.75]].forEach(([at, d]) => {
      for (const f of [466, 470, 698, 932]) voice(ctx, out, "sawtooth", f, t + at, d, 0.07, 2600);
    });
  },
  tada: (ctx, out) => {
    const t = ctx.currentTime;
    for (const f of [392, 494, 587]) voice(ctx, out, "sawtooth", f, t, 0.14, 0.06, 1800);
    for (const f of [523, 659, 784, 1046]) voice(ctx, out, "sawtooth", f, t + 0.16, 0.9, 0.055, 2200);
  },
  rimshot: (ctx, out) => {
    const t = ctx.currentTime;
    tom(ctx, out, t, 220, 0.5);
    tom(ctx, out, t + 0.18, 160, 0.55);
    noiseHit(ctx, out, t + 0.42, 0.9, 0.35, "highpass", 6000);
  },
  applause: (ctx, out) => {
    const t = ctx.currentTime;
    for (let i = 0; i < 90; i++) {
      const at = Math.random() * 2.2;
      const fade = at < 0.3 ? at / 0.3 : at > 1.6 ? Math.max(0, (2.2 - at) / 0.6) : 1;
      noiseHit(ctx, out, t + at, 0.05, 0.25 * fade, "bandpass", 1200 + Math.random() * 1800, 1.5);
    }
  },
  sad: (ctx, out) => {
    const t = ctx.currentTime;
    const notes = [293.7, 277.2, 261.6];
    notes.forEach((f, i) => voice(ctx, out, "sawtooth", f, t + i * 0.42, 0.4, 0.1, 1200));
    const last = voice(ctx, out, "sawtooth", 246.9, t + 1.26, 1.2, 0.1, 1200);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 6;
    const depth = ctx.createGain();
    depth.gain.value = 6;
    lfo.connect(depth).connect(last.frequency);
    lfo.start(t + 1.4);
    lfo.stop(t + 2.5);
  },
  crickets: (ctx, out) => {
    const t = ctx.currentTime;
    for (let c = 0; c < 4; c++) {
      for (let p = 0; p < 3; p++) voice(ctx, out, "sine", 4400, t + c * 0.55 + p * 0.05, 0.035, 0.08, 8000);
    }
  },
  bell: (ctx, out) => {
    const t = ctx.currentTime;
    for (const [m, lv] of [[1, 0.25], [2.76, 0.08], [5.4, 0.04]] as const) {
      const o = ctx.createOscillator();
      o.frequency.value = 1320 * m;
      const env = ctx.createGain();
      env.gain.setValueAtTime(lv, t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(env).connect(out);
      o.start(t);
      o.stop(t + 1.7);
    }
  },
  boing: (ctx, out) => {
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(620, t + 0.12);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.7);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 18;
    const depth = ctx.createGain();
    depth.gain.value = 40;
    lfo.connect(depth).connect(o.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.3, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.8);
    o.connect(env).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.85);
    lfo.stop(t + 0.85);
  },
};

export function isBoardSound(id: string): id is BoardSound {
  return SOUNDBOARD.some((s) => s.id === id);
}

/** Plays a soundboard sound locally at the soundboard volume. */
export function playBoard(id: string, volume = settings.value.soundboardVolume) {
  if (!isBoardSound(id)) return;
  try {
    const { ctx, out } = boardOut(Math.max(0, Math.min(1, volume)) * 1.4);
    BOARD[id](ctx, out);
  } catch {
    /* audio unavailable */
  }
}

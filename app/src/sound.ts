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
// Short sounds everyone in a voice channel hears (like Discord's soundboard).
// Recordings from Pixabay (Pixabay Content License, see public/sounds/CREDITS.md),
// levelled per sound; long ones fade out so the board stays snappy.

export const SOUNDBOARD = [
  { id: "airhorn", emoji: "📯", gain: 1.57 },
  { id: "tada", emoji: "🎉", gain: 1.23 },
  { id: "rimshot", emoji: "🥁", gain: 1.47 },
  { id: "applause", emoji: "👏", gain: 0.84, max: 4.5 },
  { id: "sad", emoji: "🎺", gain: 1.35 },
  { id: "crickets", emoji: "🦗", gain: 2.2, max: 3.5 },
  { id: "bell", emoji: "🔔", gain: 0.97 },
  { id: "boing", emoji: "🌀", gain: 0.87 },
  { id: "laugh", emoji: "😂", gain: 0.91 },
  { id: "wow", emoji: "😮", gain: 2.18 },
  { id: "drumroll", emoji: "🪘", gain: 0.92 },
  { id: "levelup", emoji: "⭐", gain: 1.16 },
  { id: "wrong", emoji: "❌", gain: 0.9 },
  { id: "kaching", emoji: "💰", gain: 0.9 },
  { id: "gong", emoji: "🔊", gain: 1.13, max: 4.5 },
  { id: "dramatic", emoji: "😱", gain: 2.07 },
] as const;
export type BoardSound = (typeof SOUNDBOARD)[number]["id"];

const decoded = new Map<string, Promise<AudioBuffer | null>>();

function load(id: string) {
  let p = decoded.get(id);
  if (!p) {
    p = fetch(`/sounds/${id}.mp3`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => engine().ctx.decodeAudioData(b))
      .catch(() => null);
    decoded.set(id, p);
  }
  return p;
}

/** Decodes all sounds ahead of time so the first click plays instantly. */
export function preloadBoard() {
  for (const s of SOUNDBOARD) void load(s.id);
}

export function isBoardSound(id: string): id is BoardSound {
  return SOUNDBOARD.some((s) => s.id === id);
}

/** Plays a soundboard sound locally at the soundboard volume. */
export async function playBoard(id: string, volume = settings.value.soundboardVolume) {
  const meta = SOUNDBOARD.find((s) => s.id === id);
  if (!meta) return;
  try {
    const buf = await load(id);
    if (!buf) return;
    const { ctx } = engine();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const level = Math.max(0, Math.min(1, volume)) * meta.gain;
    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(level, t0);
    const max = "max" in meta ? meta.max : 0;
    if (max && buf.duration > max) {
      g.gain.setValueAtTime(level, t0 + max - 0.6);
      g.gain.linearRampToValueAtTime(0.0001, t0 + max);
      src.stop(t0 + max + 0.05);
    }
    src.connect(g).connect(ctx.destination);
    src.start(t0);
  } catch {
    /* audio unavailable */
  }
}

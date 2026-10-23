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

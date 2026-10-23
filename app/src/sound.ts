// Short synthesized notification chime (no audio files shipped).

let ctx: AudioContext | null = null;
let last = 0;

export function playChime(call = false) {
  const now = Date.now();
  if (now - last < 1500) return; // avoid bursts
  last = now;
  try {
    ctx ??= new AudioContext();
    const t0 = ctx.currentTime;
    const notes = call ? [659.25, 783.99, 987.77] : [880, 1318.5];
    notes.forEach((f, i) => {
      const o = ctx!.createOscillator();
      const g = ctx!.createGain();
      o.type = "sine";
      o.frequency.value = f;
      const start = t0 + i * 0.09;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(0.07, start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      o.connect(g).connect(ctx!.destination);
      o.start(start);
      o.stop(start + 0.4);
    });
  } catch {
    /* audio unavailable */
  }
}

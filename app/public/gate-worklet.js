// Input sensitivity (noise gate) for the microphone, running on the audio
// thread so it keeps working while NexusTalk is in the background.
// "auto" follows the room's noise floor, "manual" uses a fixed threshold (dBFS).

class NexusGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mode = "auto";
    this.threshold = -50;
    this.floor = -70;
    this.level = -100;
    this.gain = 0;
    this.holdUntil = 0;
    this.lastPost = 0;
    this.port.onmessage = (e) => {
      if (e.data.mode) this.mode = e.data.mode;
      if (typeof e.data.threshold === "number") this.threshold = e.data.threshold;
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] && inputs[0][0];
    const output = outputs[0] && outputs[0][0];
    if (!input || !output) return true;
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    // Fast attack, slower decay for the level shown in the meter.
    this.level = db > this.level ? db : this.level * 0.92 + db * 0.08;
    // Noise floor: drops quickly, rises slowly (speech does not lift it).
    this.floor = db < this.floor ? this.floor * 0.7 + db * 0.3 : this.floor + 0.0025;
    const threshold = this.mode === "auto" ? Math.max(-62, Math.min(-28, this.floor + 14)) : this.threshold;
    const now = currentTime;
    if (this.mode === "off" || db > threshold) this.holdUntil = now + 0.32;
    const open = now < this.holdUntil;
    // ~5 ms attack, ~120 ms release (per 128-sample block).
    const target = open ? 1 : 0;
    const coeff = open ? 0.6 : 0.03;
    for (let i = 0; i < input.length; i++) {
      this.gain += (target - this.gain) * (i === 0 ? coeff : coeff / 32);
      output[i] = input[i] * this.gain;
    }
    if (now - this.lastPost > 0.05) {
      this.lastPost = now;
      this.port.postMessage({ level: this.level, threshold, open });
    }
    return true;
  }
}

registerProcessor("nx-gate", NexusGate);

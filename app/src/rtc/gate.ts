// Microphone chain with the input-sensitivity gate (public/gate-worklet.js).

export type GateMode = "auto" | "manual" | "off";

export interface GateInfo {
  /** Smoothed input level in dBFS. */
  level: number;
  /** Current threshold in dBFS (auto: follows the noise floor). */
  threshold: number;
  open: boolean;
}

export interface Gate {
  /** Gated audio to send. */
  stream: MediaStream;
  node: AudioWorkletNode;
  configure(mode: GateMode, threshold: number): void;
}

const loaded = new WeakSet<BaseAudioContext>();

export async function createGate(ctx: AudioContext, input: MediaStream, onInfo?: (i: GateInfo) => void): Promise<Gate> {
  if (!loaded.has(ctx)) {
    await ctx.audioWorklet.addModule("/gate-worklet.js");
    loaded.add(ctx);
  }
  const src = ctx.createMediaStreamSource(input);
  const node = new AudioWorkletNode(ctx, "nx-gate", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const dest = ctx.createMediaStreamDestination();
  src.connect(node).connect(dest);
  if (onInfo) node.port.onmessage = (e) => onInfo(e.data as GateInfo);
  return {
    stream: dest.stream,
    node,
    configure: (mode, threshold) => node.port.postMessage({ mode, threshold }),
  };
}

/** Maps dBFS (-80…0) to 0…1 for meters. */
export const dbToUnit = (db: number) => Math.max(0, Math.min(1, (db + 80) / 80));

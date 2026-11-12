// Keeps the screen on during calls (Settings › Voice), mainly for phones:
// without it Android turns the display off and may pause the app.

import { settings } from "../state/app";

type Sentinel = { release(): Promise<void>; released?: boolean };
let lock: Sentinel | null = null;
let wanted = false;

async function acquire() {
  const wl = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<Sentinel> } }).wakeLock;
  if (!wanted || !wl || document.visibilityState !== "visible" || (lock && !lock.released)) return;
  try {
    lock = await wl.request("screen");
  } catch {
    /* not allowed right now (e.g. battery saver) – the call keeps working */
  }
}

const onVisible = () => void acquire();

export function keepAwake(on: boolean) {
  wanted = on && settings.value.keepAwake;
  if (wanted) {
    document.addEventListener("visibilitychange", onVisible);
    void acquire();
  } else {
    document.removeEventListener("visibilitychange", onVisible);
    const l = lock;
    lock = null;
    void l?.release().catch(() => {});
  }
}

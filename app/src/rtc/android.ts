// Bridge to the native Android helper plugin "domus" (DomusPlugin.kt):
// a foreground service that keeps hosted servers and calls running while the
// app is in the background, and screen capture via MediaProjection.
//
// The Android web view has no getDisplayMedia(); the plugin sends the screen
// as JPEG frames, which are drawn onto a canvas whose captureStream() becomes
// the video track of the screen share.

import { isAndroidApp } from "../platform";
import { t } from "../i18n";

type Listener = { unregister(): Promise<void> };

async function core() {
  return import("@tauri-apps/api/core");
}

let state = { host: false, call: false };

/** Tells the foreground service what has to keep running. */
export async function keepAlive(patch: Partial<typeof state>) {
  if (!isAndroidApp) return;
  const next = { ...state, ...patch };
  if (next.host === state.host && next.call === state.call) return;
  state = next;
  try {
    const { invoke } = await core();
    await invoke("plugin:domus|keep_alive", {
      ...patch,
      hostTitle: t("droid.hostTitle"),
      hostText: t("droid.hostText"),
      callTitle: t("droid.callTitle"),
      callText: t("droid.callText"),
    });
  } catch {
    /* without the service Android may pause Domus in the background */
  }
}

/** Starts native screen capture; resolves to a stream with one video track. */
export async function captureAndroidScreen(opts: { maxWidth: number; fps: number }): Promise<MediaStream> {
  const { invoke, addPluginListener } = await core();
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const ctx = canvas.getContext("2d", { alpha: false })!;
  let ended = false;
  let busy = false;
  const listeners: Listener[] = [];

  const stream = canvas.captureStream(opts.fps);
  const track = stream.getVideoTracks()[0];
  const nativeStop = track.stop.bind(track);

  const cleanup = () => {
    if (ended) return false;
    ended = true;
    listeners.forEach((l) => void l.unregister().catch(() => {}));
    void invoke("plugin:domus|stop_screen_capture").catch(() => {});
    nativeStop();
    return true;
  };
  // Stopping the share in Domus stops the native capture as well.
  track.stop = () => void cleanup();

  listeners.push(
    await addPluginListener<{ data: string; width: number; height: number }>("domus", "frame", async (f) => {
      if (busy || ended) return; // drop frames while the previous one is still being drawn
      busy = true;
      try {
        const bin = atob(f.data);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        bmp.close();
      } catch {
        /* skip a broken frame */
      } finally {
        busy = false;
      }
    }),
  );
  listeners.push(
    await addPluginListener("domus", "captureStopped", () => {
      // Ended from Android (status bar, lock screen): the share ends in Domus too.
      if (cleanup()) track.dispatchEvent(new Event("ended"));
    }),
  );

  try {
    await invoke("plugin:domus|start_screen_capture", {
      maxWidth: opts.maxWidth,
      fps: opts.fps,
      quality: 60,
      title: t("droid.screenTitle"),
      text: t("droid.screenText"),
    });
  } catch (e) {
    cleanup();
    throw new DOMException(String(e), "NotAllowedError");
  }
  return stream;
}

// Platform services: desktop (Tauri) or browser fallbacks.

import type { SavedServer } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
/** Running on a phone or tablet (the Android app, or a mobile browser). */
export const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad/i.test(navigator.userAgent);
/** The Android app (no hosting, tray, global keys or screen sharing there). */
export const isAndroidApp = isTauri && isMobile;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export interface StoredConfig {
  servers: SavedServer[];
  settings: Record<string, unknown>;
  host_autostart: boolean;
  /** Start the hosted servers together with the app. */
  hosts_autostart: boolean;
  minimize_to_tray: boolean;
}

// In the browser build, `?profile=name` keeps separate settings per tab (used for
// testing several users side by side).
const profile = typeof location !== "undefined" ? new URLSearchParams(location.search).get("profile") : null;
const LS_KEY = profile ? `nexustalk.config.${profile}` : "nexustalk.config";

export async function loadConfig(): Promise<{ config: StoredConfig; warning: string | null }> {
  const empty: StoredConfig = { servers: [], settings: {}, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
  if (isTauri) {
    const r = await invoke<{ config: StoredConfig; warning: string | null }>("config_load");
    return { config: { ...empty, ...r.config, settings: (r.config.settings as Record<string, unknown>) ?? {} }, warning: r.warning };
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    return { config: raw ? { ...empty, ...JSON.parse(raw) } : empty, warning: null };
  } catch {
    return { config: empty, warning: "Gespeicherte Einstellungen waren beschädigt und wurden zurückgesetzt." };
  }
}

export async function saveConfig(cfg: StoredConfig): Promise<void> {
  if (isTauri) return invoke("config_save", { config: cfg });
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    /* storage unavailable */
  }
}

export function log(level: "info" | "warn" | "error", message: string) {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  if (isTauri) invoke("client_log", { level, message }).catch(() => {});
}

let notifyPermission: boolean | null = null;

export async function notify(title: string, body: string) {
  try {
    if (isTauri) {
      const n = await import("@tauri-apps/plugin-notification");
      if (notifyPermission === null) {
        notifyPermission = await n.isPermissionGranted();
        if (!notifyPermission) notifyPermission = (await n.requestPermission()) === "granted";
      }
      if (notifyPermission) n.sendNotification({ title, body });
      return;
    }
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") new Notification(title, { body, silent: false });
  } catch (e) {
    log("warn", `notification failed: ${e}`);
  }
}

export async function requestAttention() {
  if (!isTauri) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().requestUserAttention(2);
  } catch {
    /* ignore */
  }
}

export interface AppInfo {
  version: string;
  data_dir: string;
  log_dir: string;
  background: boolean;
  user_name: string;
}

export async function appInfo(): Promise<AppInfo | null> {
  return isTauri ? invoke<AppInfo>("app_info") : null;
}

export async function openFolder(path: string) {
  if (isTauri) await invoke("open_folder", { path });
}

export async function quitApp() {
  if (isTauri) await invoke("quit_app");
}

export async function autostart(enable?: boolean): Promise<boolean> {
  if (!isTauri) return false;
  const a = await import("@tauri-apps/plugin-autostart");
  if (enable === true) await a.enable();
  if (enable === false) await a.disable();
  return a.isEnabled();
}

export async function pickFiles(accept?: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export { invoke as tauriInvoke };

// ------------------------------------------------------------- device secrets

const secretKey = (name: string) => `nexustalk.secret.${profile ? profile + "." : ""}${name}`;

/** A secret bound to this device (desktop: protected by the Windows account). */
export async function secretGet(name: string): Promise<string | null> {
  try {
    if (isTauri) return await invoke<string | null>("secret_get", { name });
    return localStorage.getItem(secretKey(name));
  } catch {
    return null;
  }
}

export async function secretSet(name: string, value: string | null): Promise<void> {
  try {
    if (isTauri) return await invoke("secret_set", { name, value });
    if (value === null) localStorage.removeItem(secretKey(name));
    else localStorage.setItem(secretKey(name), value);
  } catch (e) {
    log("warn", `secret ${name} not saved: ${e}`);
  }
}

// ------------------------------------------------------------- saving files

/** Where received data goes: a file on disk, written piece by piece. */
export interface FileSink {
  write(chunk: Uint8Array): Promise<void>;
  /** `keep: false` removes the partial file. */
  close(keep: boolean): Promise<void>;
}

/**
 * Asks where to save `name` and returns a sink that streams to that file
 * (desktop app and Chromium browsers), or collects in memory and downloads at
 * the end (other browsers). Returns null if the user cancelled.
 */
export async function saveFile(name: string, mime = "application/octet-stream"): Promise<FileSink | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({ defaultPath: name });
    if (!path) return null;
    const core = await import("@tauri-apps/api/core");
    const id = await core.invoke<number>("file_save_begin", { path });
    // Larger pieces mean fewer round trips to the backend.
    let buf: Uint8Array[] = [];
    let size = 0;
    const flush = async () => {
      if (!size) return;
      const all = new Uint8Array(size);
      let o = 0;
      for (const b of buf) {
        all.set(b, o);
        o += b.length;
      }
      buf = [];
      size = 0;
      await core.invoke("file_save_chunk", all, { headers: { "x-id": String(id) } });
    };
    return {
      async write(chunk) {
        buf.push(chunk);
        size += chunk.length;
        if (size >= 1 << 20) await flush();
      },
      async close(keep) {
        if (keep) await flush();
        await core.invoke("file_save_end", { id, keep });
      },
    };
  }
  const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<any> }).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({ suggestedName: name });
      const w = await handle.createWritable();
      return {
        write: (chunk) => w.write(chunk),
        close: async (keep) => {
          if (keep) await w.close();
          else await w.abort();
        },
      };
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return null;
    }
  }
  const parts: BlobPart[] = [];
  return {
    async write(chunk) {
      parts.push(chunk as BlobPart);
    },
    async close(keep) {
      if (!keep) return;
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  };
}

/** Saves a finished blob (clip, exported key) through `saveFile`. */
export async function saveBlob(name: string, blob: Blob): Promise<boolean> {
  const sink = await saveFile(name, blob.type);
  if (!sink) return false;
  try {
    const CHUNK = 1 << 20;
    for (let o = 0; o < blob.size; o += CHUNK) await sink.write(new Uint8Array(await blob.slice(o, o + CHUNK).arrayBuffer()));
    await sink.close(true);
    return true;
  } catch (e) {
    await sink.close(false).catch(() => {});
    throw e;
  }
}

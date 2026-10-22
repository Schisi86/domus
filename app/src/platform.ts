// Platform services: desktop (Tauri) or browser fallbacks.

import type { SavedServer } from "./types";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
}

export interface StoredConfig {
  servers: SavedServer[];
  settings: Record<string, unknown>;
  host_autostart: boolean;
  minimize_to_tray: boolean;
}

// In the browser build, `?profile=name` keeps separate settings per tab (used for
// testing several users side by side).
const profile = typeof location !== "undefined" ? new URLSearchParams(location.search).get("profile") : null;
const LS_KEY = profile ? `nexustalk.config.${profile}` : "nexustalk.config";

export async function loadConfig(): Promise<{ config: StoredConfig; warning: string | null }> {
  const empty: StoredConfig = { servers: [], settings: {}, host_autostart: false, minimize_to_tray: true };
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

export async function pickFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.onchange = () => resolve(Array.from(input.files ?? []));
    input.click();
  });
}

export { invoke as tauriInvoke };

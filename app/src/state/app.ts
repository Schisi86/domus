// Application-wide state: saved servers, current selection, settings,
// toasts, modals, notifications and persistence.

import { computed, effect, signal } from "@preact/signals";
import type { ComponentChild } from "preact";
import { loadConfig, log, notify, requestAttention, saveConfig, type StoredConfig } from "../platform";
import type { Message, SavedServer } from "../types";
import { ServerStore } from "./server";
import { detectLang, setLang, t } from "../i18n";
import { applyTheme } from "../themes";
import { playChime } from "../sound";

// ------------------------------------------------------------- settings

export interface Settings {
  /** "" = follow the system language */
  language: string;
  /** one of THEMES (themes.ts) */
  theme: string;
  followSystemTheme: boolean;
  scale: number;
  inputDevice: string;
  outputDevice: string;
  videoDevice: string;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  pttKey: string;
  /** Push-to-talk also works while NexusTalk is in the background (desktop app). */
  globalPtt: boolean;
  globalPttKey: string;
  notifications: boolean;
  notifySound: boolean;
  autoAway: boolean;
  autoAwayMinutes: number;
  recentEmojis: string[];
  notifyDMs: boolean;
  notifyMentions: boolean;
  notifyAll: boolean;
  notifyVoiceJoin: boolean;
  /** `${serverId}` or `${serverId}:${channelId}` → muted */
  muted: Record<string, boolean>;
  /** `${serverId}:${userId}` → 0..1 */
  userVolume: Record<string, number>;
  screenProfile: "eco" | "balanced" | "high" | "manual";
  screenManual: { width: number; height: number; fps: number; kbps: number };
  screenAudio: boolean;
  showMembers: boolean;
  lastChannel: Record<string, number>;
}

export const defaultSettings: Settings = {
  language: "",
  theme: "emerald",
  followSystemTheme: false,
  scale: 1,
  inputDevice: "",
  outputDevice: "",
  videoDevice: "",
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  pushToTalk: false,
  pttKey: "KeyV",
  globalPtt: false,
  globalPttKey: "F8",
  notifications: true,
  notifySound: true,
  autoAway: true,
  autoAwayMinutes: 10,
  recentEmojis: [],
  notifyDMs: true,
  notifyMentions: true,
  notifyAll: false,
  notifyVoiceJoin: true,
  muted: {},
  userVolume: {},
  screenProfile: "balanced",
  screenManual: { width: 1920, height: 1080, fps: 30, kbps: 3000 },
  screenAudio: true,
  showMembers: true,
  lastChannel: {},
};

export const settings = signal<Settings>(defaultSettings);
export const hostAutostart = signal(false);
export const minimizeToTray = signal(true);

export function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  if ("theme" in patch || "followSystemTheme" in patch) applyTheme(settings.value.theme, settings.value.followSystemTheme);
  if ("language" in patch) void setLang(settings.value.language || detectLang());
  schedulePersist();
}

// ------------------------------------------------------------- servers & selection

export const servers = signal<ServerStore[]>([]);
/** null = home (direct messages / friends) */
export const activeServerId = signal<string | null>(null);
export const activeChannelId = signal<number | null>(null);
/** On the home screen: which server's DM is open (DMs are per server). */
export const homeDm = signal<{ serverId: string; channelId: number } | null>(null);
export const windowFocused = signal(typeof document !== "undefined" ? document.hasFocus() : true);

export const activeServer = computed(() => servers.value.find((s) => s.id === activeServerId.value) ?? null);

export function serverById(id: string) {
  return servers.value.find((s) => s.id === id) ?? null;
}

/** The server + channel whose messages are currently shown. */
export const openChannel = computed<{ server: ServerStore; channelId: number } | null>(() => {
  if (activeServerId.value === null) {
    const h = homeDm.value;
    const s = h ? serverById(h.serverId) : null;
    return s && h ? { server: s, channelId: h.channelId } : null;
  }
  const s = activeServer.value;
  return s && activeChannelId.value !== null ? { server: s, channelId: activeChannelId.value } : null;
});

export function selectServer(id: string | null) {
  activeServerId.value = id;
  if (id) {
    const s = serverById(id);
    const last = settings.value.lastChannel[id];
    const first = s?.channels.value.find((c) => c.kind === "text");
    activeChannelId.value = s?.channel(last ?? -1) ? last : (first?.id ?? null);
  }
}

export function selectChannel(cid: number) {
  activeChannelId.value = cid;
  const sid = activeServerId.value;
  if (sid) updateSettings({ lastChannel: { ...settings.value.lastChannel, [sid]: cid } });
}

export function openDm(server: ServerStore, channelId: number) {
  activeServerId.value = null;
  homeDm.value = { serverId: server.id, channelId };
}

export async function startDm(server: ServerStore, userId: number) {
  const r = await server.rpc<{ channel_id: number }>("dm.open", { user_id: userId });
  openDm(server, r.channel_id);
}

export function addServer(saved: SavedServer, select = true) {
  const existing = serverById(saved.id);
  if (existing) {
    existing.saved.value = saved;
    existing.conn.stop();
    existing.conn.start();
  } else {
    const store = new ServerStore(saved, onServerEvent);
    servers.value = [...servers.value, store];
    store.conn.start();
    watchSaved(store);
  }
  if (select) selectServer(saved.id);
  schedulePersist();
}

export function removeServer(id: string) {
  const s = serverById(id);
  s?.conn.stop();
  servers.value = servers.value.filter((x) => x.id !== id);
  if (activeServerId.value === id) selectServer(null);
  if (homeDm.value?.serverId === id) homeDm.value = null;
  schedulePersist();
}

function watchSaved(store: ServerStore) {
  let first = true;
  effect(() => {
    void store.saved.value;
    if (first) {
      first = false;
      return;
    }
    schedulePersist();
  });
}

export function isMuted(serverId: string, channelId?: number) {
  const m = settings.value.muted;
  return !!m[serverId] || (channelId !== undefined && !!m[`${serverId}:${channelId}`]);
}

// ------------------------------------------------------------- notifications

function onServerEvent(store: ServerStore, ev: string, d: any) {
  if (ev === "message.created") maybeNotifyMessage(store, d.message as Message);
  if (ev === "voice.state") maybeNotifyCall(store, d);
  if (ev === "ready" && d.reconnect) toast(t("toast.reconnected"), store.displayName(), "ok");
  if (ev === "ready" && activeServerId.value === store.id && (activeChannelId.value === null || !store.channel(activeChannelId.value))) {
    selectServer(store.id);
  }
  voiceHooks.forEach((h) => h(store, ev, d));
}

/** Voice session subscribes here for signaling events. */
export const voiceHooks = new Set<(store: ServerStore, ev: string, d: any) => void>();

function maybeNotifyMessage(store: ServerStore, m: Message) {
  const s = settings.value;
  const me = store.me.value?.id;
  if (!s.notifications || !me || m.author_id === me) return;
  const open = openChannel.value;
  const viewing = open?.server === store && open.channelId === m.channel_id && windowFocused.value;
  if (viewing) return;
  const isDm = !!store.dm(m.channel_id);
  const mentioned = m.mentions.includes(me);
  if (store.me.value?.presence === "dnd") return;
  if (isMuted(store.id, m.channel_id) && !mentioned) return;
  const relevant = (isDm && s.notifyDMs) || (mentioned && s.notifyMentions) || (s.notifyAll && !isMuted(store.id, m.channel_id));
  if (!relevant) return;
  const author = store.memberName(m.author_id);
  const where = isDm ? t("notify.dm") : `#${store.channel(m.channel_id)?.name ?? ""} · ${store.displayName()}`;
  const text = m.content.length > 140 ? m.content.slice(0, 140) + "…" : m.content || `📎 ${t("notify.attachment")}`;
  if (s.notifySound) playChime();
  void notify(`${author} (${where})`, text);
  void requestAttention();
}

function maybeNotifyCall(store: ServerStore, v: any) {
  const s = settings.value;
  const me = store.me.value?.id;
  if (!s.notifications || !s.notifyVoiceJoin || v.left || v.user_id === me || store.me.value?.presence === "dnd") return;
  const dm = store.dm(v.channel_id);
  if (!dm) return;
  // Only the first participant joining a DM call counts as a ring.
  if (store.voiceMembers(v.channel_id).length !== 1) return;
  const name = store.memberName(v.user_id);
  toast(t("notify.call"), t("notify.callBody", { name }), "info", 12000);
  if (s.notifySound) playChime(true);
  void notify(t("notify.call"), t("notify.callBody", { name }));
  void requestAttention();
}

// ------------------------------------------------------------- toasts, modals, menus

export interface Toast {
  id: number;
  title: string;
  body?: string;
  kind: "info" | "ok" | "warn" | "error";
}

export const toasts = signal<Toast[]>([]);
let toastSeq = 0;

export function toast(title: string, body?: string, kind: Toast["kind"] = "info", ms = 5000) {
  const t = { id: ++toastSeq, title, body, kind };
  toasts.value = [...toasts.value.slice(-4), t];
  setTimeout(() => dismissToast(t.id), ms);
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export const modal = signal<ComponentChild | null>(null);
export const openModal = (c: ComponentChild) => (modal.value = c);
export const closeModal = () => (modal.value = null);

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
}
export const contextMenu = signal<{ x: number; y: number; items: MenuItem[] } | null>(null);
export function showMenu(e: MouseEvent, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation();
  contextMenu.value = { x: e.clientX, y: e.clientY, items };
}

export const lightbox = signal<string | null>(null);

// ------------------------------------------------------------- persistence

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let loaded = false;

export function schedulePersist() {
  if (!loaded) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => void persistNow(), 400);
}

export async function persistNow() {
  const cfg: StoredConfig = {
    servers: servers.value.map((s) => s.saved.value),
    settings: settings.value as unknown as Record<string, unknown>,
    host_autostart: hostAutostart.value,
    minimize_to_tray: minimizeToTray.value,
  };
  try {
    await saveConfig(cfg);
  } catch (e) {
    log("error", `saving config failed: ${e}`);
    toast(t("toast.saveFailed"), String(e), "error");
  }
}

export async function initApp() {
  const { config, warning } = await loadConfig();
  const stored = config.settings as Partial<Settings>;
  // Migrate the old dark/light/system setting of version 0.1.
  if (stored.theme === "dark") stored.theme = "emerald";
  if (stored.theme === "light") stored.theme = "jade";
  if (stored.theme === "system") {
    stored.theme = "emerald";
    stored.followSystemTheme = true;
  }
  settings.value = { ...defaultSettings, ...stored };
  applyTheme(settings.value.theme, settings.value.followSystemTheme);
  await setLang(settings.value.language || detectLang());
  hostAutostart.value = config.host_autostart;
  minimizeToTray.value = config.minimize_to_tray;
  for (const s of config.servers) {
    const store = new ServerStore(s, onServerEvent);
    servers.value = [...servers.value, store];
    watchSaved(store);
    store.conn.start();
  }
  loaded = true;
  if (warning) toast(t("toast.configReset"), warning, "warn", 12000);
  initAutoAway();
  window.addEventListener("focus", () => (windowFocused.value = true));
  window.addEventListener("blur", () => (windowFocused.value = false));
  const first = servers.value[0];
  if (first) {
    // Select once the channel list is known.
    const stop = effect(() => {
      if (first.channels.value.length && activeServerId.value === null && !homeDm.value) {
        selectServer(first.id);
        queueMicrotask(() => stop());
      }
    });
    setTimeout(() => stop(), 15000);
  }
}

// ------------------------------------------------------------- automatic "away"

let lastActivity = Date.now();
let autoAwayActive = false;

function initAutoAway() {
  const mark = () => {
    lastActivity = Date.now();
    if (autoAwayActive) {
      autoAwayActive = false;
      setAllPresence("online");
    }
  };
  for (const ev of ["mousemove", "keydown", "mousedown", "wheel"]) window.addEventListener(ev, mark, { passive: true });
  window.addEventListener("focus", mark);
  // One cheap check per minute.
  setInterval(() => {
    const s = settings.value;
    if (!s.autoAway || autoAwayActive || windowFocused.value) return;
    if (Date.now() - lastActivity < s.autoAwayMinutes * 60_000) return;
    autoAwayActive = true;
    setAllPresence("idle");
  }, 60_000);
}

/** Switches between online and idle on every server where the user chose "online". */
function setAllPresence(p: "online" | "idle") {
  for (const s of servers.value) {
    const cur = s.me.value?.presence ?? "online";
    if (!s.conn.ready || (cur !== "online" && cur !== "idle")) continue;
    s.rpc("user.presence", { presence: p }).then(
      () => {
        if (s.me.value) s.me.value = { ...s.me.value, presence: p };
      },
      () => {},
    );
  }
}

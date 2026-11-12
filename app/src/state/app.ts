// Application-wide state: saved servers, current selection, settings,
// toasts, modals, notifications and persistence.

import { computed, effect, signal } from "@preact/signals";
import type { ComponentChild } from "preact";
import { isMobile, loadConfig, log, notify, requestAttention, saveConfig, type StoredConfig } from "../platform";
import type { Message, SavedServer } from "../types";
import { ServerStore } from "./server";
import { detectLang, setLang, t } from "../i18n";
import { applyTheme, RETIRED_THEMES } from "../themes";
import { play, playChime } from "../sound";

// ------------------------------------------------------------- settings

export interface Settings {
  /** "" = follow the system language */
  language: string;
  /** one of THEMES (themes.ts) */
  theme: string;
  followSystemTheme: boolean;
  /** Personal accent color ("" = the design's own). */
  accent: string;
  /** Slowly drifting light in the background. */
  ambient: boolean;
  scale: number;
  inputDevice: string;
  outputDevice: string;
  videoDevice: string;
  echoCancellation: boolean;
  /** Input sensitivity: automatic, fixed threshold or off. */
  inputGate: "auto" | "manual" | "off";
  /** Manual threshold in dBFS. */
  gateThreshold: number;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  pushToTalk: boolean;
  pttKey: string;
  /** Push-to-talk also works while Domus is in the background (desktop app). */
  globalPtt: boolean;
  globalPttKey: string;
  notifications: boolean;
  notifySound: boolean;
  /** Quiet cues for joining, leaving, switching, muting, sharing. */
  uiSounds: boolean;
  uiVolume: number;
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
  /** `${serverId}:${userId}` → muted for me only (voice and soundboard). */
  localMute: Record<string, boolean>;
  /** `${serverId}:${userId}` → private note, only stored on this device. */
  notes: Record<string, string>;
  /** Play soundboard sounds from others. */
  soundboard: boolean;
  soundboardVolume: number;
  /** Screen share: chosen in the menu before (or while) sharing. */
  screen: ScreenOpts;
  screenAudio: boolean;
  /** Webcam also sends the PC's system audio (like screen sharing). */
  cameraAudio: boolean;
  /** Show the webcam as a small overlay on the screen share (off = separate tile). */
  cameraOverlay: boolean;
  showMembers: boolean;
  /** Pane widths in px (drag the dividers). */
  sidebarWidth: number;
  membersWidth: number;
  /** Compact chat (Discord/IRC style): no avatars, one line per message. */
  compact: boolean;
  /** One-time UI migrations already applied. */
  uiRev: number;
  /** Remote control: key that switches between my PC and the stream / stops control. */
  remoteKey: string;
  /** Remote control (host): ask for a password instead of confirming each request. */
  rcUsePassword: boolean;
  /** Others may draw and point on my shared screen. */
  allowInk: boolean;
  /** Instant clips: keep the last seconds of the watched stream in memory. */
  clips: boolean;
  clipSeconds: number;
  /** Record the voices of the call into clips (the others are told). */
  clipVoices: boolean;
  clipKey: string;
  /** `${serverId}:${channelId}` → end-to-end encryption on/off for that DM. */
  e2eDm: Record<string, boolean>;
  /** `${serverId}:${userId}` → key id last seen for that person (key-change warning). */
  e2eSeen: Record<string, string>;
  lastChannel: Record<string, number>;
  /** Text size of chat messages (1 = normal), independent of the UI scale. */
  msgScale: number;
  /** Double-click (desktop) or swipe left (touch) on a message replies to it. */
  dblReply: boolean;
  /** Enter sends; otherwise Enter adds a line and the send button sends (default on phones). */
  enterSends: boolean;
  /** Keep the screen on during calls (phones). */
  keepAwake: boolean;
  /** Notifications paused until this time (ms since epoch; 0 = not paused). */
  notifyPauseUntil: number;
  /** System-wide key that toggles the microphone during calls ("" = off). */
  globalMuteKey: string;
}


export type ScreenRes = "720" | "1080" | "1440" | "2160" | "source";
export interface ScreenOpts {
  res: ScreenRes;
  fps: number;
  /** What is shared: decides between sharp text and fluid motion. */
  content: "auto" | "detail" | "motion";
  /** Upper bitrate limit in kbit/s; 0 = automatic. */
  kbps: number;
}

/** Converts the quality profiles of version 0.2 into the new options. */
function migrateScreen(old: { screenProfile?: string; screenManual?: { height: number; fps: number; kbps: number } }): ScreenOpts | undefined {
  if (!old.screenProfile) return undefined;
  if (old.screenProfile === "eco") return { res: "720", fps: 15, content: "detail", kbps: 0 };
  if (old.screenProfile === "high") return { res: "1440", fps: 60, content: "auto", kbps: 0 };
  if (old.screenProfile === "manual" && old.screenManual) {
    const h = old.screenManual.height;
    const res: ScreenRes = h <= 720 ? "720" : h <= 1080 ? "1080" : h <= 1440 ? "1440" : "2160";
    return { res, fps: Math.max(5, Math.min(60, old.screenManual.fps)), content: "auto", kbps: old.screenManual.kbps };
  }
  return { res: "1080", fps: 30, content: "auto", kbps: 0 };
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
  globalPttKey: "F7",
  notifications: true,
  notifySound: true,
  uiSounds: true,
  uiVolume: 0.6,
  autoAway: true,
  autoAwayMinutes: 10,
  recentEmojis: [],
  notifyDMs: true,
  notifyMentions: true,
  notifyAll: false,
  notifyVoiceJoin: true,
  muted: {},
  userVolume: {},
  inputGate: "auto",
  gateThreshold: -50,
  accent: "",
  ambient: true,
  localMute: {},
  notes: {},
  soundboard: true,
  soundboardVolume: 0.5,
  screen: { res: "1080", fps: 30, content: "auto", kbps: 0 },
  screenAudio: true,
  cameraAudio: true,
  cameraOverlay: true,
  showMembers: true,
  sidebarWidth: 246,
  membersWidth: 236,
  compact: false,
  uiRev: 3,
  remoteKey: "F8",
  rcUsePassword: false,
  allowInk: true,
  clips: true,
  clipSeconds: 30,
  clipVoices: true,
  clipKey: "F9",
  e2eDm: {},
  e2eSeen: {},
  lastChannel: {},
  msgScale: 1,
  dblReply: true,
  enterSends: !isMobile,
  keepAwake: true,
  notifyPauseUntil: 0,
  globalMuteKey: "",
};

export const settings = signal<Settings>(defaultSettings);
export const hostAutostart = signal(false);
/** Hosted servers start together with the app (Settings › App). */
export const hostsAutostart = signal(true);
export const minimizeToTray = signal(true);

export const PANE_LIMITS = { sidebarWidth: [200, 440, 246], membersWidth: [180, 420, 236] } as const;

/** Pane widths as CSS variables (also set live while dragging a divider). */
export function applyLayout() {
  const s = settings.value;
  const root = document.documentElement;
  root.style.setProperty("--sidebar-w", `${s.sidebarWidth}px`);
  root.style.setProperty("--members-w", `${s.membersWidth}px`);
  root.style.setProperty("--msg-scale", String(s.msgScale || 1));
}

export function updateSettings(patch: Partial<Settings>) {
  settings.value = { ...settings.value, ...patch };
  if ("theme" in patch || "followSystemTheme" in patch || "accent" in patch) applyTheme(settings.value.theme, settings.value.followSystemTheme, settings.value.accent);
  if ("language" in patch) void setLang(settings.value.language || detectLang());
  if ("sidebarWidth" in patch || "membersWidth" in patch || "msgScale" in patch) applyLayout();
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

// ------------------------------------------------------------- phone layout

const NARROW = "(max-width: 760px)";
/** Narrow screen (phone): one column at a time instead of the side-by-side panes. */
export const narrow = signal(typeof window !== "undefined" && window.matchMedia(NARROW).matches);
if (typeof window !== "undefined") window.matchMedia(NARROW).addEventListener("change", (e) => (narrow.value = e.matches));
/** Phone: the navigation (servers + channels) is shown instead of the content. */
export const mobileNav = signal(true);
/** Phone: the member list is open as a sheet over the chat. */
export const membersSheet = signal(false);
/** Shows the content column on a phone (after picking a channel or DM). */
export function showContent() {
  if (narrow.value) mobileNav.value = false;
}

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
  if (activeChannelId.value !== cid) play("switch");
  activeChannelId.value = cid;
  showContent();
  const sid = activeServerId.value;
  if (sid) updateSettings({ lastChannel: { ...settings.value.lastChannel, [sid]: cid } });
}

export function openDm(server: ServerStore, channelId: number) {
  activeServerId.value = null;
  homeDm.value = { serverId: server.id, channelId };
  showContent();
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
  if (ev === "device.linked") {
    linkedDevices.value = [...linkedDevices.value, { server: store.id, device: String(d.device ?? ""), at: Date.now() }];
    toast(t("move.linkedToast"), `${d.device || t("move.unnamed")} · ${store.displayName()}`, "ok", 8000);
  }
  if (ev === "ready" && d.reconnect) toast(t("toast.reconnected"), store.displayName(), "ok");
  if (ev === "ready" && activeServerId.value === store.id && (activeChannelId.value === null || !store.channel(activeChannelId.value))) {
    selectServer(store.id);
  }
  voiceHooks.forEach((h) => h(store, ev, d));
}

/** Devices that were just signed in with a code from this device (QR transfer). */
export const linkedDevices = signal<{ server: string; device: string; at: number }[]>([]);

/** Voice session subscribes here for signaling events. */
export const voiceHooks = new Set<(store: ServerStore, ev: string, d: any) => void>();

/** Notifications are paused for a while (bell menu or Settings › Notifications). */
export const notifyPaused = () => settings.value.notifyPauseUntil > Date.now();

function maybeNotifyMessage(store: ServerStore, m: Message) {
  const s = settings.value;
  const me = store.me.value?.id;
  if (!s.notifications || !me || m.author_id === me || notifyPaused()) return;
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
  if (!s.notifications || !s.notifyVoiceJoin || v.left || v.user_id === me || store.me.value?.presence === "dnd" || notifyPaused()) return;
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
/** Second layer above `modal` for confirmations, prompts and the image cropper,
 *  so the window underneath stays open. */
export const dialog = signal<ComponentChild | null>(null);
export const openDialog = (c: ComponentChild) => (dialog.value = c);
export const closeDialog = () => (dialog.value = null);

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  /** Shows a check mark (toggle entries). */
  checked?: boolean;
  /** Opens a submenu on hover/click instead of running an action. */
  sub?: MenuItem[];
  /** Small section caption (not clickable). */
  heading?: boolean;
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
    hosts_autostart: hostsAutostart.value,
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
  // Designs that no longer exist move to their closest successor.
  if (stored.theme && RETIRED_THEMES[stored.theme]) stored.theme = RETIRED_THEMES[stored.theme];
  if (!stored.screen) {
    const migrated = migrateScreen(stored as never);
    if (migrated) stored.screen = migrated;
  }
  delete (stored as Record<string, unknown>).screenProfile;
  delete (stored as Record<string, unknown>).screenManual;
  settings.value = { ...defaultSettings, ...stored };
  // 0.8: the member list is shown by default again.
  if ((settings.value.uiRev ?? 0) < 3) settings.value = { ...settings.value, showMembers: true, screenAudio: true, cameraAudio: true, uiRev: 3 };
  applyLayout();
  applyTheme(settings.value.theme, settings.value.followSystemTheme, settings.value.accent);
  await setLang(settings.value.language || detectLang());
  hostAutostart.value = config.host_autostart;
  hostsAutostart.value = config.hosts_autostart !== false;
  minimizeToTray.value = config.minimize_to_tray;
  for (const s of config.servers) {
    // Entries of the single hosted server of version 0.2 belong to host "main".
    if (s.hosted && !s.host_id) s.host_id = "main";
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

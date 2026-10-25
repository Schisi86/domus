// Internationalization: 15 languages, German is the source language.
// Only the selected language is loaded (separate chunk per locale); missing
// keys fall back to English, then German.

import { signal } from "@preact/signals";
import de from "./locales/de";
import type { ApiErr } from "../types";
import type { NetError } from "../net/transport";
import { P } from "../types";

export type Dict = typeof de;
export type Key = keyof Dict;
export type Partial = { [K in Key]?: string };

export interface LangInfo {
  code: string;
  name: string;
  flag: string;
  rtl?: boolean;
}

/** The 15 supported languages, shown with their country flag. */
export const LANGS: LangInfo[] = [
  { code: "de", name: "Deutsch", flag: "de" },
  { code: "en", name: "English", flag: "gb" },
  { code: "es", name: "Español", flag: "es" },
  { code: "fr", name: "Français", flag: "fr" },
  { code: "it", name: "Italiano", flag: "it" },
  { code: "pt", name: "Português", flag: "pt" },
  { code: "nl", name: "Nederlands", flag: "nl" },
  { code: "pl", name: "Polski", flag: "pl" },
  { code: "tr", name: "Türkçe", flag: "tr" },
  { code: "ru", name: "Русский", flag: "ru" },
  { code: "ar", name: "العربية", flag: "sa", rtl: true },
  { code: "hi", name: "हिन्दी", flag: "in" },
  { code: "zh", name: "中文", flag: "cn" },
  { code: "ja", name: "日本語", flag: "jp" },
  { code: "ko", name: "한국어", flag: "kr" },
];

const loaders: Record<string, () => Promise<{ default: Partial }>> = {
  en: () => import("./locales/en"),
  es: () => import("./locales/es"),
  fr: () => import("./locales/fr"),
  it: () => import("./locales/it"),
  pt: () => import("./locales/pt"),
  nl: () => import("./locales/nl"),
  pl: () => import("./locales/pl"),
  tr: () => import("./locales/tr"),
  ru: () => import("./locales/ru"),
  ar: () => import("./locales/ar"),
  hi: () => import("./locales/hi"),
  zh: () => import("./locales/zh"),
  ja: () => import("./locales/ja"),
  ko: () => import("./locales/ko"),
};

/** Current language code; components re-render when it changes. */
export const lang = signal("de");
let active: Partial = {};
let english: Partial = {};

export function langInfo(code = lang.value): LangInfo {
  return LANGS.find((l) => l.code === code) ?? LANGS[0];
}

/** Picks the best supported language for the system locale. */
export function detectLang(): string {
  const prefs = typeof navigator !== "undefined" ? navigator.languages ?? [navigator.language] : [];
  for (const p of prefs) {
    const c = p.toLowerCase().split("-")[0];
    if (LANGS.some((l) => l.code === c)) return c;
  }
  return "en";
}

export async function setLang(code: string) {
  if (!LANGS.some((l) => l.code === code)) code = "de";
  if (code !== "de" && !Object.keys(english).length && loaders.en) english = (await loaders.en()).default;
  active = code === "de" ? {} : code === "en" ? english : (await loaders[code]()).default;
  const info = langInfo(code);
  document.documentElement.lang = code;
  document.documentElement.dir = info.rtl ? "rtl" : "ltr";
  lang.value = code;
}

/** Translates `key`; `{name}` placeholders are replaced from `vars`. */
export function t(key: Key, vars?: Record<string, string | number>): string {
  const code = lang.value; // subscribe the calling component to language changes
  let s = code === "de" ? de[key] : (active[key] ?? english[key] ?? de[key]);
  if (s === undefined) s = key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// ------------------------------------------------------------- formatting

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions, id: string) {
  const k = `${lang.value}|${id}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = new Intl.DateTimeFormat(lang.value, opts);
    fmtCache.set(k, f);
  }
  return f;
}

export function fmtTime(ms: number) {
  return fmt({ hour: "2-digit", minute: "2-digit" }, "t").format(ms);
}

export function fmtDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return t("time.today");
  if (d.toDateString() === yesterday.toDateString()) return t("time.yesterday");
  return fmt({ day: "2-digit", month: "2-digit", year: "numeric" }, "d").format(ms);
}

export function fmtStamp(ms: number) {
  const d = new Date(ms);
  const sameDay = (x: Date) => d.toDateString() === x.toDateString();
  if (sameDay(new Date())) return t("time.todayAt", { time: fmtTime(ms) });
  if (sameDay(new Date(Date.now() - 86_400_000))) return t("time.yesterdayAt", { time: fmtTime(ms) });
  return `${fmtDay(ms)} ${fmtTime(ms)}`;
}

export function fmtFull(ms: number) {
  return fmt({ dateStyle: "full", timeStyle: "short" }, "f").format(ms);
}

export function fmtBytes(n: number) {
  const nf = (v: number, d = 1) => v.toLocaleString(lang.value, { maximumFractionDigits: d });
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${nf(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${nf(n / 1024 ** 2)} MB`;
  return `${nf(n / 1024 ** 3, 2)} GB`;
}

export function fmtDuration(secs: number) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? t("time.dh", { d, h }) : h ? t("time.hm", { h, m }) : t("time.m", { m });
}

// ------------------------------------------------------------- errors

const ERROR_KEYS: Record<string, Key> = {
  BAD_REQUEST: "err.BAD_REQUEST",
  VALIDATION: "err.VALIDATION",
  UNAUTHORIZED: "err.UNAUTHORIZED",
  INVALID_CREDENTIALS: "err.INVALID_CREDENTIALS",
  ACCOUNT_PENDING: "err.ACCOUNT_PENDING",
  ACCOUNT_BANNED: "err.ACCOUNT_BANNED",
  REGISTRATION_CLOSED: "err.REGISTRATION_CLOSED",
  INVALID_INVITE: "err.INVALID_INVITE",
  USERNAME_TAKEN: "err.USERNAME_TAKEN",
  PERMISSION_DENIED: "err.PERMISSION_DENIED",
  NOT_FOUND: "err.NOT_FOUND",
  CONFLICT: "err.CONFLICT",
  RATE_LIMITED: "err.RATE_LIMITED",
  TOO_LARGE: "err.TOO_LARGE",
  UPLOADS_DISABLED: "err.UPLOADS_DISABLED",
  STORAGE_FULL: "err.STORAGE_FULL",
  BLOCKED: "err.BLOCKED",
  VOICE_FULL: "err.VOICE_FULL",
  SERVER_FULL: "err.SERVER_FULL",
  INTERNAL: "err.INTERNAL",
  OFFLINE: "err.OFFLINE",
  TIMEOUT: "err.TIMEOUT",
};

/** Human readable message for a server or network error. Server detail texts are German, so they are only shown in German. */
export function errorText(e: unknown): string {
  if (!e) return t("err.unknown");
  if (typeof e === "string") return e;
  const a = e as { code?: string; msg?: string; kind?: string };
  if (a.code) {
    const detailed = ["VALIDATION", "BAD_REQUEST", "CONFLICT", "VOICE_FULL"].includes(a.code);
    if (detailed && a.msg && lang.value === "de") return a.msg;
    const k = ERROR_KEYS[a.code];
    return k ? t(k) : (a.msg ?? a.code);
  }
  if (a.kind) return netErrorText(a as NetError);
  if (e instanceof Error) return e.message;
  return String(e);
}

export type { ApiErr };

export function netErrorText(e: NetError): string {
  switch (e.kind) {
    case "untrusted":
      return t("net.untrusted");
    case "mismatch":
      return t("net.mismatch");
    case "bad_url":
      return t("net.badUrl");
    case "timeout":
      return t("net.timeout");
    case "status":
      return t("net.status", { status: e.status });
    case "connect":
      return t("net.connect", { detail: e.message });
  }
}

// ------------------------------------------------------------- domain labels

export const PERMISSIONS: { bit: number; key: string; channel?: boolean }[] = [
  { bit: P.VIEW_CHANNEL, key: "view", channel: true },
  { bit: P.SEND_MESSAGES, key: "send", channel: true },
  { bit: P.ATTACH_FILES, key: "attach", channel: true },
  { bit: P.MANAGE_MESSAGES, key: "manageMessages", channel: true },
  { bit: P.CONNECT, key: "connect", channel: true },
  { bit: P.SPEAK, key: "speak", channel: true },
  { bit: P.VIDEO, key: "video", channel: true },
  { bit: P.SCREEN_SHARE, key: "screen", channel: true },
  { bit: P.CREATE_CHANNELS, key: "createChannels" },
  { bit: P.MANAGE_CHANNELS, key: "manageChannels" },
  { bit: P.CREATE_INVITES, key: "invite" },
  { bit: P.BAN_MEMBERS, key: "ban" },
  { bit: P.KICK_MEMBERS, key: "kick" },
  { bit: P.MODERATE_MEMBERS, key: "timeout" },
  { bit: P.MUTE_MEMBERS, key: "muteMembers", channel: true },
  { bit: P.MOVE_MEMBERS, key: "moveMembers" },
  { bit: P.MANAGE_ROLES, key: "roles" },
  { bit: P.MANAGE_SERVER, key: "server" },
  { bit: P.VIEW_AUDIT_LOG, key: "audit" },
  { bit: P.ADMINISTRATOR, key: "admin" },
];

export const permName = (k: string) => t(`perm.${k}` as Key);
export const permDesc = (k: string) => t(`perm.${k}.d` as Key);
export const regMode = (m: string) => t(`reg.${m}` as Key);
export const presenceText = (p: string) => t(`presence.${p}` as Key);

// German UI texts for error codes and permissions. German is the default and
// currently only language; strings are kept here to allow adding others.

import type { ApiErr } from "./types";
import type { NetError } from "./net/transport";
import { P } from "./types";

const ERRORS: Record<string, string> = {
  BAD_REQUEST: "Ungültige Anfrage.",
  VALIDATION: "Eingabe ist ungültig.",
  UNAUTHORIZED: "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.",
  INVALID_CREDENTIALS: "Benutzername oder Passwort ist falsch.",
  ACCOUNT_PENDING: "Dein Konto wartet noch auf Freischaltung durch einen Moderator.",
  ACCOUNT_BANNED: "Dein Konto wurde auf diesem Server gesperrt.",
  REGISTRATION_CLOSED: "Auf diesem Server ist eine Registrierung nur mit Einladung möglich.",
  INVALID_INVITE: "Die Einladung ist ungültig oder abgelaufen.",
  USERNAME_TAKEN: "Dieser Benutzername ist bereits vergeben.",
  PERMISSION_DENIED: "Dafür fehlt dir die Berechtigung.",
  NOT_FOUND: "Nicht gefunden.",
  CONFLICT: "Aktion nicht möglich.",
  RATE_LIMITED: "Zu viele Anfragen – bitte einen Moment warten.",
  TOO_LARGE: "Die Datei ist zu groß.",
  UPLOADS_DISABLED: "Dateiuploads sind auf diesem Server deaktiviert.",
  STORAGE_FULL: "Der Speicherplatz des Servers ist erschöpft.",
  BLOCKED: "Mit diesem Benutzer ist keine Kommunikation möglich.",
  VOICE_FULL: "Der Sprachkanal ist voll.",
  SERVER_FULL: "Der Server ist ausgelastet.",
  INTERNAL: "Interner Serverfehler.",
  OFFLINE: "Keine Verbindung zum Server.",
  TIMEOUT: "Der Server antwortet nicht.",
};

/** Human readable message for a server error; prefers the server's detail text for validation errors. */
export function errorText(e: unknown): string {
  if (!e) return "Unbekannter Fehler";
  if (typeof e === "string") return e;
  const a = e as Partial<ApiErr> & Partial<NetError>;
  if (a.code) {
    if ((a.code === "VALIDATION" || a.code === "BAD_REQUEST" || a.code === "CONFLICT" || a.code === "VOICE_FULL") && a.msg) return a.msg;
    return ERRORS[a.code] ?? a.msg ?? a.code;
  }
  if (a.kind) return netErrorText(a as NetError);
  if (e instanceof Error) return e.message;
  return String(e);
}

export function netErrorText(e: NetError): string {
  switch (e.kind) {
    case "untrusted":
      return "Das Zertifikat des Servers ist nicht bekannt.";
    case "mismatch":
      return "WARNUNG: Das Zertifikat des Servers hat sich geändert. Möglicherweise wird die Verbindung abgefangen.";
    case "bad_url":
      return "Die Serveradresse ist ungültig.";
    case "timeout":
      return "Zeitüberschreitung – der Server ist nicht erreichbar.";
    case "status":
      return `Der Server antwortete mit Status ${e.status}.`;
    case "connect":
      return `Server nicht erreichbar (${e.message}). Prüfe Adresse, Port und Firewall.`;
  }
}

export const PERMISSION_INFO: { bit: number; name: string; desc: string; channel?: boolean }[] = [
  { bit: P.VIEW_CHANNEL, name: "Kanäle sehen", desc: "Kanäle betreten und Nachrichten lesen.", channel: true },
  { bit: P.SEND_MESSAGES, name: "Nachrichten senden", desc: "Nachrichten in Textkanälen schreiben.", channel: true },
  { bit: P.ATTACH_FILES, name: "Dateien anhängen", desc: "Dateien hochladen.", channel: true },
  { bit: P.MANAGE_MESSAGES, name: "Nachrichten moderieren", desc: "Nachrichten anderer löschen.", channel: true },
  { bit: P.CONNECT, name: "Sprachkanälen beitreten", desc: "Sprachkanäle betreten und zuhören.", channel: true },
  { bit: P.SPEAK, name: "Sprechen", desc: "Mikrofon in Sprachkanälen übertragen.", channel: true },
  { bit: P.VIDEO, name: "Kamera", desc: "Webcam übertragen.", channel: true },
  { bit: P.SCREEN_SHARE, name: "Bildschirm übertragen", desc: "Bildschirm oder Fenster freigeben.", channel: true },
  { bit: P.CREATE_CHANNELS, name: "Kanäle erstellen", desc: "Neue Kanäle und Kategorien anlegen." },
  { bit: P.MANAGE_CHANNELS, name: "Kanäle bearbeiten", desc: "Kanäle umbenennen, verschieben und löschen." },
  { bit: P.CREATE_INVITES, name: "Benutzer einladen", desc: "Einladungen erstellen." },
  { bit: P.BAN_MEMBERS, name: "Benutzer verwalten", desc: "Registrierungen freischalten, Benutzer sperren und entsperren." },
  { bit: P.MANAGE_ROLES, name: "Rollen verwalten", desc: "Rollen bearbeiten und vergeben (unterhalb der eigenen)." },
  { bit: P.MANAGE_SERVER, name: "Server verwalten", desc: "Servereinstellungen ändern, Protokolle einsehen." },
  { bit: P.VIEW_AUDIT_LOG, name: "Audit-Protokoll", desc: "Moderationsprotokoll und Status einsehen." },
  { bit: P.ADMINISTRATOR, name: "Administrator", desc: "Alle Rechte. Nur an vertrauenswürdige Personen vergeben." },
];

export const REG_MODES: Record<string, string> = {
  closed: "Geschlossen (keine Registrierung)",
  invite: "Nur mit Einladung (empfohlen)",
  approval: "Offen mit Freischaltung durch Moderatoren",
  open: "Offen für alle (nicht empfohlen)",
};

export const PRESENCE_TEXT: Record<string, string> = {
  online: "Online",
  idle: "Abwesend",
  dnd: "Bitte nicht stören",
  invisible: "Unsichtbar",
  offline: "Offline",
};

const dateFmt = new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
const timeFmt = new Intl.DateTimeFormat("de-DE", { hour: "2-digit", minute: "2-digit" });
const fullFmt = new Intl.DateTimeFormat("de-DE", { dateStyle: "full", timeStyle: "short" });

export function fmtTime(ms: number) {
  return timeFmt.format(ms);
}

export function fmtDay(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Heute";
  if (d.toDateString() === yesterday.toDateString()) return "Gestern";
  return dateFmt.format(ms);
}

export function fmtStamp(ms: number) {
  const day = fmtDay(ms);
  return day === "Heute" || day === "Gestern" ? `${day} um ${fmtTime(ms)}` : `${day} ${fmtTime(ms)}`;
}

export function fmtFull(ms: number) {
  return fullFmt.format(ms);
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function fmtDuration(secs: number) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d} T ${h} Std` : h ? `${h} Std ${m} Min` : `${m} Min`;
}

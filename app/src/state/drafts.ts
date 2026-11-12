// Unsent text per channel: switching channels (or restarting the app) keeps
// what was typed. Stored only on this device.

import { signal } from "@preact/signals";

const KEY = "domus.drafts";
const MAX = 200;

function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const texts: Record<string, string> = load();
/** Channels that have a draft (`${serverId}:${channelId}`), for the pencil mark in the sidebar. */
export const draftKeys = signal<Set<string>>(new Set(Object.keys(texts)));

let timer: ReturnType<typeof setTimeout> | null = null;
function persist() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(texts));
    } catch {
      /* storage unavailable: drafts stay in memory */
    }
  }, 500);
}

export const draftKey = (serverId: string, channelId: number) => `${serverId}:${channelId}`;

export function getDraft(serverId: string, channelId: number): string {
  return texts[draftKey(serverId, channelId)] ?? "";
}

export function setDraft(serverId: string, channelId: number, text: string) {
  const k = draftKey(serverId, channelId);
  const had = k in texts;
  if (text.trim()) {
    texts[k] = text.slice(0, 8000);
    const keys = Object.keys(texts);
    if (keys.length > MAX) delete texts[keys[0]];
  } else delete texts[k];
  if (had !== k in texts) draftKeys.value = new Set(Object.keys(texts));
  persist();
}

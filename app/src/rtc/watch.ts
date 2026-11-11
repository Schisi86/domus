// Watching together: a video link (YouTube or a direct media URL) that every
// participant of the call plays for themselves, kept in sync over the call's
// data channel – play, pause and seeking apply to everyone. A local video file
// is instead played for the others as a stream (see `playFileForAll`).

import { signal } from "@preact/signals";
import { toast } from "../state/app";
import { t } from "../i18n";
import type { VoiceSession } from "./voice";

export interface WatchState {
  /** Changes with every new video. */
  id: string;
  /** Who started it. */
  by: number;
  kind: "yt" | "url";
  /** YouTube video id or the media URL. */
  src: string;
  title: string;
  playing: boolean;
  /** Position in seconds at the moment the state was written. */
  pos: number;
  /** Logical clock: the highest number wins, so everyone converges. */
  n: number;
}

/** Recognizes a YouTube link (watch, short, share, embed) or a plain media URL. */
export function parseWatchInput(input: string): { kind: "yt" | "url"; src: string; start: number } | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^(www|m|music)\./, "");
  const startRaw = url.searchParams.get("t") ?? url.searchParams.get("start") ?? "";
  const hms = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(startRaw);
  const start = hms && startRaw ? Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0) : 0;
  let id: string | null = null;
  if (host === "youtu.be") id = url.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const m = /^\/(?:shorts|embed|live|v)\/([^/?]+)/.exec(url.pathname);
      if (m) id = m[1];
    }
  }
  if (id !== null) return /^[\w-]{11}$/.test(id) ? { kind: "yt", src: id, start } : null;
  return { kind: "url", src: url.toString(), start: 0 };
}

function validState(st: any): st is WatchState {
  return (
    st &&
    typeof st.id === "string" && st.id.length <= 40 &&
    typeof st.by === "number" &&
    (st.kind === "yt" ? /^[\w-]{11}$/.test(st.src) : st.kind === "url" && typeof st.src === "string" && st.src.length <= 2000 && /^https?:\/\//i.test(st.src)) &&
    typeof st.title === "string" && st.title.length <= 200 &&
    typeof st.playing === "boolean" &&
    typeof st.pos === "number" && Number.isFinite(st.pos) && st.pos >= 0 &&
    Number.isInteger(st.n) && st.n > 0
  );
}

export class WatchSession {
  state = signal<WatchState | null>(null);
  /** I closed the player for myself; the others keep watching. */
  hidden = signal(false);
  /** `performance.now()` when `state.pos` was valid on this client. */
  private at = 0;
  private lastWriter = 0;

  constructor(private v: VoiceSession) {
    v.onData("watch", (from, m) => this.onMessage(from, m));
    // Someone joins later: hand over what is playing right now.
    v.onPeerReady((uid) => {
      const st = this.snapshot();
      if (st) v.sendTo(uid, { t: "watch", st });
    });
  }

  /** Where playback should be right now, in seconds. */
  position(): number {
    const st = this.state.value;
    if (!st) return 0;
    return st.playing ? st.pos + (performance.now() - this.at) / 1000 : st.pos;
  }

  private snapshot(): WatchState | null {
    const st = this.state.value;
    return st ? { ...st, pos: this.position() } : null;
  }

  private adopt(st: WatchState, writer: number) {
    this.at = performance.now();
    this.lastWriter = writer;
    if (this.state.value?.id !== st.id) this.hidden.value = false;
    this.state.value = st;
  }

  private onMessage(from: number, m: any) {
    const cur = this.state.value;
    if (typeof m.end === "string") {
      if (cur && cur.id === m.end) {
        this.state.value = null;
        toast(t("watch.ended", { name: this.v.server.memberName(from) }), undefined, "info", 3500);
      }
      return;
    }
    if (!validState(m.st)) return;
    const st = m.st as WatchState;
    // Highest clock wins; on a tie the lower user id – everyone ends up equal.
    if (cur && (st.n < cur.n || (st.n === cur.n && from >= this.lastWriter))) return;
    if (!cur || cur.id !== st.id) toast(t("watch.startedBy", { name: this.v.server.memberName(st.by) }), st.title || undefined, "info", 4500);
    this.adopt(st, from);
  }

  /** Starts a video for everyone. Returns false if the link is not usable. */
  start(input: string): boolean {
    const parsed = parseWatchInput(input);
    if (!parsed) return false;
    const st: WatchState = {
      id: crypto.randomUUID(),
      by: this.v.selfId,
      kind: parsed.kind,
      src: parsed.src,
      title: parsed.kind === "url" ? decodeURIComponent(parsed.src.split("/").pop()?.split("?")[0] ?? "").slice(0, 120) : "",
      playing: true,
      pos: parsed.start,
      n: (this.state.value?.n ?? 0) + 1,
    };
    this.adopt(st, this.v.selfId);
    this.v.broadcast({ t: "watch", st });
    return true;
  }

  /** Play, pause, seek or a title learned from the player – applies to everyone. */
  update(patch: Partial<Pick<WatchState, "playing" | "pos" | "title">>) {
    const cur = this.snapshot();
    if (!cur) return;
    const st = { ...cur, ...patch, n: cur.n + 1 };
    this.adopt(st, this.v.selfId);
    this.v.broadcast({ t: "watch", st });
  }

  /** Ends the video for everyone. */
  stop() {
    const cur = this.state.value;
    if (!cur) return;
    this.state.value = null;
    this.v.broadcast({ t: "watch", end: cur.id });
  }

  dispose() {
    this.state.value = null;
    stopFilePlay();
  }
}

// ------------------------------------------------------------- local file for everyone

/** The local video file that is being played for the call (as my stream). */
export const filePlay = signal<{ name: string; el: HTMLVideoElement; url: string } | null>(null);

type CapturingVideo = HTMLVideoElement & { captureStream?: () => MediaStream };

/**
 * Plays a local video file for everyone in the call: the picture and sound are
 * sent like a screen share, so nobody else needs the file.
 */
export async function playFileForAll(v: VoiceSession, file: File): Promise<boolean> {
  stopFilePlay();
  const el = document.createElement("video") as CapturingVideo;
  if (!el.captureStream) {
    toast(t("watch.fileUnsupported"), undefined, "error");
    return false;
  }
  const url = URL.createObjectURL(file);
  el.src = url;
  el.playsInline = true;
  el.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      el.onloadeddata = () => resolve();
      el.onerror = () => reject(new Error(el.error?.message || "format"));
    });
    await el.play();
  } catch (e) {
    URL.revokeObjectURL(url);
    toast(t("watch.fileFailed"), String((e as Error).message ?? e), "error");
    return false;
  }
  const stream = el.captureStream();
  if (!stream.getVideoTracks().length) {
    el.pause();
    URL.revokeObjectURL(url);
    toast(t("watch.fileFailed"), t("watch.fileNoVideo"), "error");
    return false;
  }
  filePlay.value = { name: file.name, el, url };
  if (!(await v.publishScreen(stream, { monitor: false, capture: false, file: true }))) {
    stopFilePlay();
    return false;
  }
  el.onended = () => void v.stopScreen();
  return true;
}

/** Stops the file player (the stream itself is ended by `stopScreen`). */
export function stopFilePlay() {
  const f = filePlay.value;
  if (!f) return;
  filePlay.value = null;
  f.el.onended = null;
  f.el.pause();
  f.el.removeAttribute("src");
  f.el.load();
  URL.revokeObjectURL(f.url);
}

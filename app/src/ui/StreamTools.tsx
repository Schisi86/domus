// Tools around a stream in a call: drawing and pointing on it, instant clips,
// watching a video together and playing a local video file for everyone.

import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { closeDialog, openDialog, settings, toast } from "../state/app";
import { errorText, fmtBytes, t } from "../i18n";
import { has, P } from "../types";
import { isTauri, pickFiles, saveBlob } from "../platform";
import { voice, type VoiceSession } from "../rtc/voice";
import { inkColor, inkTool } from "../rtc/ink";
import { drawInk, INK_COLORS } from "../rtc/inkdraw";
import { filePlay, parseWatchInput, playFileForAll } from "../rtc/watch";
import type { Clip } from "../rtc/clips";
import { Icon, IconButton, Modal, Popover, ProgressBar, Spinner } from "./components";

// ------------------------------------------------------------- annotations

/** Canvas over a stream tile: shows everyone's marks and takes my pen / pointer. */
export function InkLayer({ v, uid }: { v: VoiceSession; uid: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wake = useRef<() => void>(() => {});
  const version = v.ink.version.value;
  const tool = inkTool.value;
  const usable = tool !== "off" && v.ink.allowed(uid) && v.controlling.value !== uid;

  useEffect(() => {
    const c = ref.current;
    const tile = c?.parentElement;
    const video = tile?.querySelector("video");
    if (!c || !tile || !video) return;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    let running = false;
    // Keep the canvas exactly on the picture (without the letterbox bars).
    const layout = () => {
      const tr = tile.getBoundingClientRect();
      const r = video.getBoundingClientRect();
      const vw = video.videoWidth || r.width;
      const vh = video.videoHeight || r.height;
      const scale = Math.min(r.width / vw, r.height / vh) || 1;
      const w = vw * scale;
      const h = vh * scale;
      c.style.left = `${r.left - tr.left + (r.width - w) / 2}px`;
      c.style.top = `${r.top - tr.top + (r.height - h) / 2}px`;
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const dpr = window.devicePixelRatio || 1;
      const pw = Math.max(1, Math.round(w * dpr));
      const ph = Math.max(1, Math.round(h * dpr));
      if (c.width !== pw || c.height !== ph) {
        c.width = pw;
        c.height = ph;
      }
    };
    const frame = () => {
      layout();
      const alive = drawInk(ctx, c.width, c.height, v.ink.strokes.get(uid) ?? [], v.ink.pointers.get(uid)?.values() ?? [], Date.now());
      if (alive) raf = requestAnimationFrame(frame);
      else running = false;
    };
    wake.current = () => {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    };
    wake.current();
    const ro = new ResizeObserver(() => wake.current());
    ro.observe(tile);
    video.addEventListener("resize", wake.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      video.removeEventListener("resize", wake.current);
    };
  }, [uid]);

  useEffect(() => wake.current(), [version, usable]);

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  const drawing = useRef(false);

  return (
    <canvas
      ref={ref}
      class={`ink-layer${usable ? ` tool-${tool}` : ""}`}
      onClick={usable ? (e) => e.stopPropagation() : undefined}
      onPointerDown={
        usable
          ? (e) => {
              e.stopPropagation();
              if (tool !== "pen" || e.button !== 0) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              drawing.current = true;
              const p = at(e);
              v.ink.draw(uid, p.x, p.y, true);
            }
          : undefined
      }
      onPointerMove={
        usable
          ? (e) => {
              const p = at(e);
              if (tool === "laser") v.ink.point(uid, p.x, p.y);
              else if (drawing.current) v.ink.draw(uid, p.x, p.y, false);
            }
          : undefined
      }
      onPointerUp={
        usable
          ? () => {
              if (!drawing.current) return;
              drawing.current = false;
              v.ink.endStroke();
            }
          : undefined
      }
      onPointerLeave={usable && tool === "laser" ? () => v.ink.point(uid, null, null) : undefined}
    />
  );
}

/** Pen, laser pointer, colours and "wipe" for a stream tile. */
export function InkTools({ v, uid }: { v: VoiceSession; uid: number }) {
  const tool = inkTool.value;
  void v.ink.version.value;
  if (!v.ink.allowed(uid)) return null;
  const pick = (next: "pen" | "laser") => (e: MouseEvent) => {
    e.stopPropagation();
    if (tool === "laser") v.ink.point(uid, null, null);
    inkTool.value = tool === next ? "off" : next;
  };
  const marks = (v.ink.strokes.get(uid) ?? []).some((s) => uid === v.selfId || s.from === v.selfId);
  return (
    <>
      {tool === "pen" && (
        <span class="ink-colors" onClick={(e) => e.stopPropagation()}>
          {INK_COLORS.map((c) => (
            <button key={c} class={inkColor.value === c ? "on" : ""} style={{ background: c }} aria-label={c} onClick={() => (inkColor.value = c)} />
          ))}
        </span>
      )}
      {marks && (
        <IconButton title={uid === v.selfId ? t("ink.clearAll") : t("ink.clearMine")} onClick={(e) => { e.stopPropagation(); v.ink.clear(uid); }}>
          <Icon.Eraser />
        </IconButton>
      )}
      <IconButton title={t("ink.pen")} active={tool === "pen"} onClick={pick("pen")}>
        <Icon.Pen />
      </IconButton>
      <IconButton title={t("ink.laser")} active={tool === "laser"} onClick={pick("laser")}>
        <Icon.Pointer />
      </IconButton>
    </>
  );
}

// ------------------------------------------------------------- clips

function fmtDur(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

function ClipDialog({ v, clip }: { v: VoiceSession; clip: Clip }) {
  const server = v.server;
  const [url] = useState(() => URL.createObjectURL(clip.blob));
  const [busy, setBusy] = useState<"save" | "share" | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => () => URL.revokeObjectURL(url), []);
  const uploads = server.info.value?.uploads_enabled ?? false;
  const maxUpload = (server.info.value?.max_upload_mb ?? 25) * 1024 * 1024;
  const targets = server.channels.value.filter((c) => c.kind === "text" && has(c.perms, P.SEND_MESSAGES | P.ATTACH_FILES));
  const last = settings.value.lastChannel[server.id];
  const [target, setTarget] = useState<number>(targets.find((c) => c.id === last)?.id ?? targets[0]?.id ?? 0);
  const tooBig = clip.blob.size > maxUpload;

  const save = async () => {
    setBusy("save");
    try {
      if (await saveBlob(clip.name, clip.blob)) {
        toast(t("clip.saved"), clip.name, "ok");
        closeDialog();
      }
    } catch (e) {
      toast(t("clip.saveFailed"), String(e), "error");
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    setBusy("share");
    try {
      const id = await server.upload(target, new File([clip.blob], clip.name, { type: clip.blob.type }), setProgress);
      await server.send(target, "", null, [id]);
      toast(t("clip.shared"), `#${server.channel(target)?.name ?? ""}`, "ok");
      closeDialog();
    } catch (e) {
      toast(t("clip.shareFailed"), errorText(e), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      layer="dialog"
      title={t("clip.title")}
      sub={`${server.memberName(clip.uid)} · ${fmtDur(clip.seconds)} · ${fmtBytes(clip.blob.size)}`}
      footer={
        <>
          <button class="btn ghost" onClick={closeDialog}>{t("clip.discard")}</button>
          <button class="btn primary" disabled={busy !== null} onClick={() => void save()}>
            {busy === "save" ? <Spinner /> : <><Icon.Download size={15} /> {t("clip.save")}</>}
          </button>
        </>
      }
    >
      <video class="clip-preview" src={url} controls autoPlay loop />
      {uploads && targets.length > 0 && (
        <div class="clip-share">
          <select class="select grow" value={String(target)} onChange={(e) => setTarget(Number((e.target as HTMLSelectElement).value))}>
            {targets.map((c) => (
              <option key={c.id} value={String(c.id)}>#{c.name}</option>
            ))}
          </select>
          <button class="btn outline" disabled={busy !== null || tooBig} onClick={() => void share()}>
            {busy === "share" ? <Spinner /> : <><Icon.Send size={14} /> {t("clip.share")}</>}
          </button>
        </div>
      )}
      {busy === "share" && <ProgressBar value={progress} />}
      {tooBig && uploads && <div class="faint xs">{t("clip.tooBig", { max: fmtBytes(maxUpload) })}</div>}
    </Modal>
  );
}

/** Cuts a clip from the running buffer and shows the save / share dialog. */
export async function makeClip(v: VoiceSession) {
  if (v.clips.source.value === null) {
    toast(t("clip.noBuffer"), settings.value.clips ? t("clip.noStream") : t("clip.disabled"), "warn");
    return;
  }
  const clip = await v.clips.capture();
  if (!clip) return toast(t("clip.failed"), undefined, "warn");
  openDialog(<ClipDialog v={v} clip={clip} />);
}

export function ClipButton({ v, uid }: { v: VoiceSession; uid: number }) {
  if (v.clips.source.value !== uid) return null;
  return (
    <IconButton
      title={t("clip.make", { key: settings.value.clipKey })}
      disabled={v.clips.busy.value}
      onClick={(e) => {
        e.stopPropagation();
        void makeClip(v);
      }}
    >
      <Icon.Scissors />
    </IconButton>
  );
}

/** The clip key works everywhere in the app – and system-wide in the desktop app. */
export function useClipHotkey() {
  const v = voice.value;
  const key = settings.value.clipKey;
  const on = settings.value.clips && !!v;
  useEffect(() => {
    if (!on || !key) return;
    const fire = () => {
      const cur = voice.value;
      if (cur) void makeClip(cur);
    };
    let unregister: (() => void) | null = null;
    let cancelled = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== key || e.repeat) return;
      e.preventDefault();
      fire();
    };
    if (isTauri) {
      void import("@tauri-apps/plugin-global-shortcut")
        .then(async (gs) => {
          await gs.register(key, (ev) => ev.state === "Pressed" && fire());
          if (cancelled) await gs.unregister(key).catch(() => {});
          else unregister = () => void gs.unregister(key).catch(() => {});
        })
        // Key taken by another program: it still works while Domus has the focus.
        .catch(() => window.addEventListener("keydown", onKey));
    } else window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      unregister?.();
      window.removeEventListener("keydown", onKey);
    };
  }, [on, key]);
}

// ------------------------------------------------------------- watch together

/** Voice control: start a video for everyone – by link or from a local file. */
export function WatchButton({ v }: { v: VoiceSession }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [link, setLink] = useState("");
  const st = v.watch.state.value;
  const file = filePlay.value;
  const parsed = link.trim() ? parseWatchInput(link) : null;
  const close = () => setAnchor(null);
  const start = () => {
    if (!v.watch.start(link)) return toast(t("watch.badLink"), t("watch.badLinkBody"), "warn");
    setLink("");
    close();
  };
  const pickFile = async () => {
    close();
    const [f] = await pickFiles("video/*,audio/*");
    if (f) await playFileForAll(v, f);
  };
  return (
    <>
      <button
        class={`round-btn${st || file ? " on" : ""}`}
        title={t("watch.title")}
        aria-label={t("watch.title")}
        onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Icon.Film />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={close}>
          <div class="watch-menu">
            <h4><Icon.Film size={17} /> {t("watch.title")}</h4>
            <div class="faint xs">{t("watch.hint")}</div>
            <div class="row" style={{ gap: "6px" }}>
              <input
                class="input grow"
                placeholder={t("watch.linkPh")}
                value={link}
                autoFocus
                onInput={(e) => setLink((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => e.key === "Enter" && start()}
              />
              <button class="btn primary" disabled={!parsed} onClick={start}><Icon.Play size={14} /></button>
            </div>
            {link.trim() && <div class={`xs ${parsed ? "faint" : "error-text"}`}>{parsed ? (parsed.kind === "yt" ? t("watch.kindYt") : t("watch.kindUrl")) : t("watch.badLinkBody")}</div>}
            <button class="btn outline block" disabled={v.sharingScreen.value && !file} title={v.sharingScreen.value && !file ? t("watch.fileBusy") : undefined} onClick={() => void pickFile()}>
              <Icon.Upload size={15} /> {t("watch.file")}
            </button>
            <div class="faint xs">{t("watch.fileHint")}</div>
            {st && (
              <button class="btn danger block" onClick={() => { v.watch.stop(); close(); }}>
                <Icon.Stop size={14} /> {t("watch.stopAll")}
              </button>
            )}
            {st && v.watch.hidden.value && (
              <button class="btn block" onClick={() => { v.watch.hidden.value = false; close(); }}>{t("watch.show")}</button>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}

const YT_ORIGIN = "https://www.youtube-nocookie.com";

interface Player {
  time(): number;
  playing(): boolean | null;
  seek(s: number): void;
  play(): void;
  pause(): void;
  volume(v: number): void;
}

/** The shared player: everyone plays the video themselves, kept in sync. */
export function WatchTile({ v, children }: { v: VoiceSession; children?: ComponentChildren }) {
  const st = v.watch.state.value!;
  const frame = useRef<HTMLIFrameElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const player = useRef<Player | null>(null);
  const [duration, setDuration] = useState(0);
  const [now, setNow] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [direct, setDirect] = useState(false);
  const dragging = useRef(false);
  const vol = useRef(volume);
  vol.current = volume;

  // Build the player for this video.
  useEffect(() => {
    setError(null);
    setDuration(0);
    setBlocked(false);
    if (st.kind === "url") {
      const el = video.current!;
      el.volume = vol.current;
      const onErr = () => setError(t("watch.loadFailed"));
      const onMeta = () => setDuration(Number.isFinite(el.duration) ? el.duration : 0);
      el.addEventListener("error", onErr);
      el.addEventListener("loadedmetadata", onMeta);
      player.current = {
        time: () => el.currentTime,
        playing: () => (el.readyState >= 2 ? !el.paused : null),
        seek: (s) => (el.currentTime = s),
        play: () => void el.play().catch(() => setBlocked(true)),
        pause: () => el.pause(),
        volume: (x) => (el.volume = x),
      };
      return () => {
        el.removeEventListener("error", onErr);
        el.removeEventListener("loadedmetadata", onMeta);
        player.current = null;
      };
    }
    // YouTube: driven through the embed's message interface.
    const f = frame.current!;
    let info: { currentTime?: number; duration?: number; playerState?: number; videoData?: { title?: string } } = {};
    let infoAt = 0;
    let ready = false;
    const post = (o: Record<string, unknown>) => f.contentWindow?.postMessage(JSON.stringify(o), YT_ORIGIN);
    const cmd = (func: string, args: unknown[] = []) => post({ event: "command", func, args });
    const hello = setInterval(() => !ready && post({ event: "listening", id: 1, channel: "widget" }), 400);
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== YT_ORIGIN || e.source !== f.contentWindow) return;
      let d: any;
      try {
        d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!ready) {
        ready = true;
        cmd("setVolume", [Math.round(vol.current * 100)]);
      }
      if (d?.event === "onError") setError(t("watch.ytBlocked"));
      if (d?.info && typeof d.info === "object") {
        info = { ...info, ...d.info };
        if (typeof d.info.currentTime === "number") infoAt = performance.now();
        if (typeof info.duration === "number" && info.duration > 0) setDuration(info.duration);
        const title = info.videoData?.title;
        const cur = v.watch.state.value;
        if (title && cur && cur.id === st.id && !cur.title && cur.by === v.selfId) v.watch.update({ title: title.slice(0, 150) });
      }
    };
    window.addEventListener("message", onMsg);
    player.current = {
      time: () => (info.currentTime ?? 0) + (info.playerState === 1 ? (performance.now() - infoAt) / 1000 : 0),
      playing: () => (info.playerState === 1 ? true : info.playerState === 2 || info.playerState === 5 || info.playerState === -1 ? false : null),
      seek: (s) => {
        cmd("seekTo", [s, true]);
        info.currentTime = s;
        infoAt = performance.now();
      },
      play: () => cmd("playVideo"),
      pause: () => cmd("pauseVideo"),
      volume: (x) => cmd("setVolume", [Math.round(x * 100)]),
    };
    return () => {
      clearInterval(hello);
      window.removeEventListener("message", onMsg);
      player.current = null;
    };
  }, [st.id]);

  // Follow the shared state: position and play / pause.
  useEffect(() => {
    let stuck = 0;
    const sync = () => {
      const p = player.current;
      const cur = v.watch.state.value;
      if (!p || !cur) return;
      const want = v.watch.position();
      if (!dragging.current) setNow(duration ? Math.min(duration, want) : want);
      const playing = p.playing();
      if (playing === null) return;
      if (Math.abs(p.time() - want) > (cur.playing ? 1.2 : 0.4)) p.seek(want);
      if (cur.playing && !playing) {
        p.play();
        // Still not running after a few tries: the browser wants a click first.
        if (++stuck >= 4) setBlocked(true);
      } else {
        stuck = 0;
        if (!cur.playing && playing) p.pause();
        else if (cur.playing) setBlocked(false);
      }
    };
    sync();
    const id = setInterval(sync, 700);
    return () => clearInterval(id);
  }, [st.id, st.n, duration]);

  useEffect(() => player.current?.volume(volume), [volume]);

  const src = st.kind === "yt"
    ? `${YT_ORIGIN}/embed/${st.src}?enablejsapi=1&autoplay=1&controls=0&rel=0&playsinline=1&iv_load_policy=3&start=${Math.floor(st.pos)}&origin=${encodeURIComponent(location.origin)}`
    : st.src;

  return (
    <div class="tile screen watch-tile">
      {st.kind === "yt" ? (
        <iframe ref={frame} key={st.id} src={src} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" title={st.title || "YouTube"} />
      ) : (
        <video ref={video} key={st.id} src={src} playsInline />
      )}
      {/* Clicks go to the shared controls, not into the player (unless "direct" is on). */}
      {!direct && <div class="watch-shield" onClick={() => v.watch.update({ playing: !st.playing })} />}
      {error && <div class="watch-error">{error}</div>}
      {blocked && !error && (
        <button class="watch-unblock btn primary lg" onClick={() => { setBlocked(false); player.current?.play(); }}>
          <Icon.Play size={18} /> {t("watch.clickToPlay")}
        </button>
      )}
      <div class="tile-label">{st.title || t("watch.title")} · {t("watch.by", { name: v.server.memberName(st.by) })}</div>
      <div class="tile-tools">
        {st.kind === "yt" && (
          <IconButton title={t("watch.direct")} active={direct} onClick={() => setDirect(!direct)}>
            <Icon.Pointer />
          </IconButton>
        )}
        <IconButton title={t("watch.hide")} onClick={() => (v.watch.hidden.value = true)}>
          <Icon.EyeOff />
        </IconButton>
        <IconButton title={t("voice.fullscreen")} onClick={(e) => void (e.currentTarget as HTMLElement).closest(".tile")?.requestFullscreen?.()}>
          <Icon.Maximize />
        </IconButton>
        {children}
      </div>
      <div class="watch-bar" onClick={(e) => e.stopPropagation()}>
        <IconButton title={st.playing ? t("watch.pause") : t("watch.play")} onClick={() => v.watch.update({ playing: !st.playing })}>
          {st.playing ? <Icon.Pause /> : <Icon.Play />}
        </IconButton>
        <span class="mono xs">{fmtDur(now)}</span>
        <input
          class="range grow"
          type="range"
          min={0}
          max={duration || Math.max(now, 1)}
          step={1}
          value={now}
          disabled={!duration}
          aria-label={t("watch.seek")}
          onInput={(e) => {
            dragging.current = true;
            setNow(Number((e.target as HTMLInputElement).value));
          }}
          onChange={(e) => {
            dragging.current = false;
            v.watch.update({ pos: Number((e.target as HTMLInputElement).value) });
          }}
        />
        <span class="mono xs">{duration ? fmtDur(duration) : "–:––"}</span>
        <Icon.Volume size={16} />
        <input class="range watch-vol" type="range" min={0} max={1} step={0.05} value={volume} aria-label={t("snd.volume")} onInput={(e) => setVolume(Number((e.target as HTMLInputElement).value))} />
        <button class="btn sm danger" title={t("watch.stopAll")} onClick={() => v.watch.stop()}><Icon.Stop size={13} /></button>
      </div>
    </div>
  );
}

/** Controls on my own stream tile while I play a local file for everyone. */
export function FileBar({ v }: { v: VoiceSession }) {
  const f = filePlay.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!f) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [f]);
  if (!f || !v.screenIsFile.value) return null;
  const el = f.el;
  const dur = Number.isFinite(el.duration) ? el.duration : 0;
  return (
    <div class="watch-bar" onClick={(e) => e.stopPropagation()}>
      <IconButton title={el.paused ? t("watch.play") : t("watch.pause")} onClick={() => { if (el.paused) void el.play(); else el.pause(); tick((n) => n + 1); }}>
        {el.paused ? <Icon.Play /> : <Icon.Pause />}
      </IconButton>
      <span class="mono xs">{fmtDur(el.currentTime)}</span>
      <input class="range grow" type="range" min={0} max={dur || 1} step={1} value={el.currentTime} disabled={!dur} aria-label={t("watch.seek")} onInput={(e) => { el.currentTime = Number((e.target as HTMLInputElement).value); tick((n) => n + 1); }} />
      <span class="mono xs">{dur ? fmtDur(dur) : "–:––"}</span>
      <Icon.Volume size={16} />
      <input class="range watch-vol" type="range" min={0} max={1} step={0.05} value={el.volume} aria-label={t("snd.volume")} onInput={(e) => { el.volume = Number((e.target as HTMLInputElement).value); tick((n) => n + 1); }} />
      <span class="xs ellipsis watch-file-name" title={f.name}>{f.name}</span>
    </div>
  );
}

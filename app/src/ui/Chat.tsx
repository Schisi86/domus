// Text channel / DM view: header, message history, composer, search, pins.

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { closeModal, lightbox, openDm, openModal, removeSaved, saveForLater, selectChannel, selectServer, settings, showMenu, startDm, toast, updateSettings, windowFocused } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Attachment, Member, Message, Poll } from "../types";
import { has, P } from "../types";
import { errorText, fmtBytes, fmtDay, fmtFull, fmtStamp, fmtTime, t } from "../i18n";
import { Avatar, Field, IconButton, Icon, Modal, ProgressBar, Spinner, Toggle, confirmDialog, copyText, loadBlobUrl } from "./components";
import { transport } from "../net/transport";
import { pickFiles } from "../platform";
import { joinVoice, voice } from "../rtc/voice";
import { ProfileCard, memberMenu, timeoutActive } from "./Members";
import { Markdown, wrapSelection } from "./markdown";
import { EmojiPicker } from "./EmojiPicker";

export const jumpTarget = signal<{ serverId: string; channelId: number; messageId: number } | null>(null);
/** Files dropped onto the message list, picked up by the composer. */
const droppedFiles = signal<File[]>([]);
/** Text inserted by the emoji picker of the composer. */
export const insertText = signal<string | null>(null);
/** "Mark as unread": keeps the marker in place until the channel is left. */
const unreadHold = signal<{ serverId: string; channelId: number; from: number } | null>(null);
const GROUP_MS = 7 * 60 * 1000;
const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀"];

// ------------------------------------------------------------- attachments

function LazyImage({ server, att }: { server: ServerStore; att: Attachment }) {
  const ref = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (visible && att.size <= 15 * 1024 * 1024) loadBlobUrl(server, `/api/v1/files/${att.id}`).then(setUrl);
  }, [visible]);
  return (
    <div ref={ref}>
      {url ? (
        <img class="att-img" src={url} alt={att.filename} title={att.filename} onClick={() => (lightbox.value = url)} />
      ) : (
        <div class="att-img-placeholder">{att.size > 15 * 1024 * 1024 ? <FileCard server={server} att={att} /> : <Spinner />}</div>
      )}
    </div>
  );
}

function FileCard({ server, att }: { server: ServerStore; att: Attachment }) {
  const [progress, setProgress] = useState<number | null>(null);
  const download = async () => {
    setProgress(0);
    try {
      const ok = await transport.download(server.target(), `/api/v1/files/${att.id}`, server.token, att.filename, (d, tot) => tot && setProgress(d / tot));
      if (ok) toast(t("chat.downloadDone"), att.filename, "ok");
    } catch (e) {
      toast(t("chat.downloadFailed"), errorText(e), "error");
    } finally {
      setProgress(null);
    }
  };
  return (
    <div class="att-file">
      <Icon.File size={26} />
      <div class="meta">
        <div class="ellipsis" title={att.filename}>{att.filename}</div>
        <div class="faint xs">{fmtBytes(att.size)}</div>
        {progress !== null && <ProgressBar value={progress} />}
      </div>
      <IconButton title={t("chat.download")} onClick={download} disabled={progress !== null}>
        <Icon.Download />
      </IconButton>
    </div>
  );
}

// ------------------------------------------------------------- voice messages

const SPEEDS = [1, 1.5, 2];

/** Peaks for the waveform (0..1), computed once per file. */
const waveCache = new Map<string, Promise<{ peaks: number[]; duration: number } | null>>();
function waveform(url: string, bars = 48) {
  let p = waveCache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new OfflineAudioContext(1, 1, 44100);
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const step = Math.max(1, Math.floor(data.length / bars));
        const peaks: number[] = [];
        for (let i = 0; i < bars; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j += 16) m = Math.max(m, Math.abs(data[j]));
          peaks.push(m);
        }
        const top = Math.max(0.01, ...peaks);
        return { peaks: peaks.map((x) => Math.max(0.08, x / top)), duration: audio.duration };
      } catch {
        return null;
      }
    })();
    waveCache.set(url, p);
  }
  return p;
}

function fmtClock(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** Inline player for voice messages and audio files: waveform, seek, speed. */
function AudioMessage({ server, att }: { server: ServerStore; att: Attachment }) {
  const [url, setUrl] = useState<string | null>(null);
  const [wave, setWave] = useState<{ peaks: number[]; duration: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState(1);
  const audio = useRef<HTMLAudioElement | null>(null);
  const voiceMsg = /\.weba$/i.test(att.filename);
  useEffect(() => {
    let alive = true;
    loadBlobUrl(server, `/api/v1/files/${att.id}`).then((u) => {
      if (!alive || !u) return;
      setUrl(u);
      void waveform(u).then((w) => alive && setWave(w));
    });
    return () => {
      alive = false;
      audio.current?.pause();
    };
  }, [att.id]);
  const el = () => {
    if (!audio.current && url) {
      const a = new Audio(url);
      a.ontimeupdate = () => setPos(a.currentTime);
      a.onended = () => {
        setPlaying(false);
        setPos(0);
      };
      a.onpause = () => setPlaying(false);
      a.onplay = () => setPlaying(true);
      const out = settings.value.outputDevice;
      const sink = (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
      if (sink && out) void sink.call(a, out).catch(() => {});
      audio.current = a;
    }
    return audio.current;
  };
  const toggle = () => {
    const a = el();
    if (!a) return;
    if (a.paused) {
      // Only one voice message plays at a time.
      document.dispatchEvent(new CustomEvent("nx-audio-play", { detail: a }));
      a.playbackRate = speed;
      void a.play().catch(() => {});
    } else a.pause();
  };
  useEffect(() => {
    const stop = (e: Event) => (e as CustomEvent).detail !== audio.current && audio.current?.pause();
    document.addEventListener("nx-audio-play", stop);
    return () => document.removeEventListener("nx-audio-play", stop);
  }, []);
  const duration = wave?.duration ?? 0;
  const progress = duration ? Math.min(1, pos / duration) : 0;
  const seek = (e: MouseEvent) => {
    const a = el();
    if (!a || !duration) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(duration, ((e.clientX - r.left) / r.width) * duration));
    setPos(a.currentTime);
  };
  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (audio.current) audio.current.playbackRate = next;
  };
  return (
    <div class={`audio-msg${playing ? " playing" : ""}`}>
      <button class="audio-play" onClick={toggle} disabled={!url} title={playing ? t("vm.pause") : t("vm.play")} aria-label={playing ? t("vm.pause") : t("vm.play")}>
        {!url ? <Spinner /> : playing ? <Icon.Pause size={16} /> : <Icon.Play size={16} />}
      </button>
      <div class="audio-body">
        {!voiceMsg && <div class="xs ellipsis audio-name" title={att.filename}>{att.filename}</div>}
        <div class="wave" onClick={seek} role="slider" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(pos)} aria-label={t("vm.seek")}>
          {(wave?.peaks ?? Array.from({ length: 48 }, () => 0.15)).map((h, i, arr) => (
            <i key={i} class={i / arr.length < progress ? "on" : ""} style={{ height: `${Math.round(h * 100)}%` }} />
          ))}
        </div>
      </div>
      <span class="audio-time">{fmtClock(playing || pos ? pos : duration)}</span>
      <button class="audio-speed" onClick={cycleSpeed} title={t("vm.speed")}>{speed}×</button>
    </div>
  );
}

/** Records a voice message in the composer (opus/webm, max. 5 minutes). */
function useRecorder(onDone: (file: File) => void) {
  const [state, setState] = useState<{ start: number; level: number[] } | null>(null);
  const ref = useRef<{ rec: MediaRecorder; stream: MediaStream; chunks: Blob[]; cancel: boolean; timer: ReturnType<typeof setInterval>; ctx: AudioContext } | null>(null);
  const start = async () => {
    if (ref.current) return;
    const st = settings.value;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined, echoCancellation: true, noiseSuppression: st.noiseSuppression, autoGainControl: true } });
    } catch (e) {
      return toast(t("vm.micFailed"), String(e), "error");
    }
    const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const rec = new MediaRecorder(stream, { mimeType: type, audioBitsPerSecond: 48000 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    const begun = Date.now();
    const timer = setInterval(() => {
      an.getByteTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v - 128) / 128);
      setState((s) => (s ? { start: s.start, level: [...s.level.slice(-31), Math.min(1, m * 1.6)] } : s));
      if (Date.now() - begun > 5 * 60 * 1000) stop(false);
    }, 90);
    rec.onstop = () => {
      const r = ref.current;
      ref.current = null;
      stream.getTracks().forEach((tr) => tr.stop());
      clearInterval(timer);
      void ctx.close();
      setState(null);
      if (!r || r.cancel || !chunks.length) return;
      if (Date.now() - begun < 700) return toast(t("vm.tooShort"), undefined, "warn", 2500);
      onDone(new File(chunks, `sprachnachricht-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.weba`, { type: "audio/webm" }));
    };
    ref.current = { rec, stream, chunks, cancel: false, timer, ctx };
    rec.start(250);
    setState({ start: Date.now(), level: [] });
  };
  const stop = (cancel: boolean) => {
    const r = ref.current;
    if (!r) return;
    r.cancel = cancel;
    if (r.rec.state !== "inactive") r.rec.stop();
  };
  useEffect(() => () => stop(true), []);
  return { recording: state, start, stop };
}

// ------------------------------------------------------------- polls

function PollView({ server, msg, poll, me, canVote }: { server: ServerStore; msg: Message; poll: Poll; me: number; canVote: boolean }) {
  const [busy, setBusy] = useState(false);
  const ended = poll.ends_at !== null && poll.ends_at <= Date.now();
  const mine = poll.options.map((o, i) => (o.voters.includes(me) ? i : -1)).filter((i) => i >= 0);
  const voters = new Set(poll.options.flatMap((o) => o.voters));
  const total = poll.options.reduce((n, o) => n + o.voters.length, 0);
  const max = Math.max(0, ...poll.options.map((o) => o.voters.length));
  const vote = async (i: number) => {
    if (ended || !canVote || busy) return;
    const next = poll.multi ? (mine.includes(i) ? mine.filter((x) => x !== i) : [...mine, i]) : mine.includes(i) ? [] : [i];
    setBusy(true);
    try {
      await server.rpc("poll.vote", { message_id: msg.id, options: next });
    } catch (e) {
      toast(t("poll.voteFailed"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class={`poll${ended ? " ended" : ""}`}>
      <div class="poll-q"><Icon.Poll size={16} /> <span class="grow">{poll.question}</span></div>
      <div class="faint xs">{poll.multi ? t("poll.multiHint") : t("poll.singleHint")}</div>
      <div class="poll-options">
        {poll.options.map((o, i) => {
          const pct = total ? Math.round((o.voters.length / total) * 100) : 0;
          const picked = mine.includes(i);
          const winner = ended && o.voters.length === max && max > 0;
          return (
            <button
              key={i}
              class={`poll-opt${picked ? " picked" : ""}${winner ? " winner" : ""}`}
              disabled={ended || !canVote || busy}
              title={o.voters.length ? o.voters.map((u) => server.memberName(u)).join(", ") : t("poll.noVotes")}
              onClick={() => void vote(i)}
              aria-pressed={picked}
            >
              <span class="poll-bar" style={{ width: `${pct}%` }} />
              <span class={`poll-check${poll.multi ? " multi" : ""}`}>{picked && <Icon.Check size={12} />}</span>
              <span class="grow ellipsis">{o.text}</span>
              <span class="poll-count">{o.voters.length} · {pct} %</span>
            </button>
          );
        })}
      </div>
      <div class="poll-foot faint xs">
        {t("poll.votes", { n: voters.size })} ·{" "}
        {ended ? t("poll.ended") : poll.ends_at ? t("poll.endsAt", { time: fmtFull(poll.ends_at) }) : t("poll.open")}
      </div>
    </div>
  );
}

const POLL_HOURS: [number, string][] = [
  [1, "poll.h1"],
  [4, "poll.h4"],
  [24, "poll.h24"],
  [72, "poll.h72"],
  [168, "poll.h168"],
  [0, "poll.hOpen"],
];

function PollDialog({ server, channelId }: { server: ServerStore; channelId: number }) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [hours, setHours] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const filled = options.filter((o) => o.trim()).length;
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await server.rpc("poll.create", { channel_id: channelId, question, options, multi, hours });
      closeModal();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t("poll.create")}
      footer={
        <>
          <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
          <button class="btn primary" disabled={busy || !question.trim() || filled < 2} onClick={() => void create()}>{t("poll.post")}</button>
        </>
      }
    >
      <Field label={t("poll.question")} error={error}>
        <input class="input" autoFocus maxLength={300} value={question} placeholder={t("poll.questionPh")} onInput={(e) => setQuestion((e.target as HTMLInputElement).value)} />
      </Field>
      <div class="col" style={{ gap: "6px" }}>
        <div class="label" style={{ margin: "0px" }}>{t("poll.answers")}</div>
        {options.map((o, i) => (
          <div class="row" key={i}>
            <input
              class="input grow"
              maxLength={80}
              value={o}
              placeholder={t("poll.answerPh", { n: i + 1 })}
              onInput={(e) => {
                const v = (e.target as HTMLInputElement).value;
                const next = options.map((x, j) => (j === i ? v : x));
                // A new empty field appears as soon as the last one is used.
                if (i === next.length - 1 && v && next.length < 10) next.push("");
                setOptions(next);
              }}
            />
            {options.length > 2 && (
              <IconButton title={t("common.remove")} class="sm" onClick={() => setOptions(options.filter((_, j) => j !== i))}><Icon.X /></IconButton>
            )}
          </div>
        ))}
      </div>
      <Field label={t("poll.duration")}>
        <select class="select" value={hours} onChange={(e) => setHours(Number((e.target as HTMLSelectElement).value))}>
          {POLL_HOURS.map(([h, k]) => <option key={h} value={h}>{t(k as "poll.h1")}</option>)}
        </select>
      </Field>
      <Toggle checked={multi} onChange={setMulti} label={t("poll.multi")} desc={t("poll.multiDesc")} />
    </Modal>
  );
}

/** Forward a message to another channel or a DM of the same server. */
function ForwardDialog({ server, msg }: { server: ServerStore; msg: Message }) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const q = filter.trim().toLowerCase();
  const targets = [
    ...server.channels.value.filter((c) => c.kind === "text" && has(c.perms, P.SEND_MESSAGES)).map((c) => ({ id: c.id, label: `# ${c.name}`, dm: false, uid: 0 })),
    ...server.dms.value.map((d) => ({ id: d.channel_id, label: server.memberName(d.user_id), dm: true, uid: d.user_id })),
  ].filter((x) => x.id !== msg.channel_id && (!q || x.label.toLowerCase().includes(q)));
  const send = async (cid: number) => {
    setBusy(cid);
    try {
      await server.rpc("message.forward", { message_id: msg.id, channel_id: cid });
      toast(t("fwd.done"), undefined, "ok", 2500);
      closeModal();
    } catch (e) {
      toast(t("fwd.failed"), errorText(e), "error");
      setBusy(null);
    }
  };
  return (
    <Modal title={t("fwd.title")} sub={t("fwd.sub")}>
      <div class="card small fwd-preview">
        <b>{server.memberName(msg.forwarded_from ?? msg.author_id)}</b>
        <div class="ellipsis muted">{msg.content || t("fwd.attachments", { n: msg.attachments.length })}</div>
      </div>
      <input class="input" autoFocus placeholder={t("fwd.search")} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <div class="col fwd-list">
        {targets.map((x) => (
          <div class="list-item" key={x.id}>
            {x.dm ? <Avatar server={server} userId={x.uid} name={x.label} size={24} /> : <Icon.Hash size={18} />}
            <span class="grow ellipsis">{x.label}</span>
            <button class="btn sm primary" disabled={busy !== null} onClick={() => void send(x.id)}>
              {busy === x.id ? <Spinner /> : t("fwd.send")}
            </button>
          </div>
        ))}
        {!targets.length && <div class="faint small">{t("fwd.none")}</div>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------- message item

interface ItemProps {
  server: ServerStore;
  msg: Message;
  compact: boolean;
  me: number;
  canManage: boolean;
  canPin: boolean;
  canReact: boolean;
  onReply: (m: Message) => void;
  editing: boolean;
  setEditing: (id: number | null) => void;
}

function MessageItem({ server, msg, compact, me, canManage, canPin, canReact, onReply, editing, setEditing }: ItemProps) {
  const author: Member | undefined = server.member(msg.author_id);
  const name = server.memberName(msg.author_id);
  const own = msg.author_id === me;
  const mentioned = msg.mentions.includes(me);
  const color = server.roleColor(msg.author_id);
  const [draft, setDraft] = useState(msg.content);
  const [picker, setPicker] = useState<DOMRect | null>(null);

  const react = (emoji: string) => {
    const mine = msg.reactions.find((r) => r.emoji === emoji)?.users.includes(me);
    server.rpc(mine ? "reaction.remove" : "reaction.add", { message_id: msg.id, emoji }).catch((e) => toast(t("common.error"), errorText(e), "error"));
  };
  const remove = async () => {
    if (await confirmDialog({ title: t("chat.deleteTitle"), body: t("chat.deleteBody"), confirm: t("common.delete"), danger: true })) {
      server.rpc("message.delete", { message_id: msg.id }).catch((e) => toast(t("common.deleteFailed"), errorText(e), "error"));
    }
  };
  const pin = () =>
    server
      .rpc("message.pin", { message_id: msg.id, pinned: !msg.pinned_at })
      .then(() => toast(msg.pinned_at ? t("chat.unpinned") : t("chat.pinned"), undefined, "ok", 2000), (e) => toast(t("common.error"), errorText(e), "error"));
  const save = async () => {
    const text = draft.trim();
    if (text === msg.content) return setEditing(null);
    try {
      await server.rpc("message.edit", { message_id: msg.id, content: text });
      setEditing(null);
    } catch (e) {
      toast(t("chat.editFailed"), errorText(e), "error");
    }
  };
  const endPoll = () => server.rpc("poll.end", { message_id: msg.id }).catch((e) => toast(t("common.error"), errorText(e), "error"));
  const markUnread = () => {
    unreadHold.value = { serverId: server.id, channelId: msg.channel_id, from: msg.id - 1 };
    void server.markUnread(msg.channel_id, msg.id).catch((e) => toast(t("common.error"), errorText(e), "error"));
  };
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      { label: t("chat.reply"), onClick: () => onReply(msg) },
      ...(canReact ? [{ label: t("chat.addReaction"), onClick: () => setPicker((e.target as HTMLElement).getBoundingClientRect()) }] : []),
      ...(!msg.poll ? [{ label: t("fwd.action"), onClick: () => openModal(<ForwardDialog server={server} msg={msg} />) }] : []),
      ...(own && !msg.poll ? [{ label: t("common.edit"), onClick: () => { setDraft(msg.content); setEditing(msg.id); } }] : []),
      ...(canPin ? [{ label: msg.pinned_at ? t("chat.unpin") : t("chat.pin"), onClick: pin }] : []),
      ...(msg.poll && (own || canManage) && !(msg.poll.ends_at && msg.poll.ends_at <= Date.now()) ? [{ label: t("poll.end"), onClick: endPoll }] : []),
      isSaved
        ? { label: t("later.remove"), onClick: () => removeSaved(server.id, msg.id) }
        : {
            label: t("later.save"),
            sub: [
              { label: t("later.noReminder"), onClick: () => later(null) },
              { separator: true, label: "" },
              { label: t("later.in20"), onClick: () => later(20) },
              { label: t("later.in60"), onClick: () => later(60) },
              { label: t("later.in180"), onClick: () => later(180) },
              { label: t("later.tomorrow"), onClick: () => later("tomorrow") },
            ],
          },
      { label: t("chat.markUnread"), onClick: markUnread },
      { separator: true, label: "" },
      { label: t("chat.copyText"), onClick: () => copyText(msg.content) },
      ...(!own ? [{ label: t("member.sendDm"), onClick: () => void startDm(server, msg.author_id).catch((er) => toast(t("common.error"), errorText(er), "error")) }] : []),
      { label: t("chat.copyId"), onClick: () => copyText(String(msg.id)) },
      ...(own || canManage ? [{ separator: true, label: "" }, { label: t("common.delete"), danger: true, onClick: remove }] : []),
    ]);
  const authorMenu = (e: MouseEvent) => author && memberMenu(e, server, author);
  const later = (minutes: number | "tomorrow" | null) => {
    let remindAt: number | null = null;
    if (minutes === "tomorrow") {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      remindAt = d.getTime();
    } else if (minutes) remindAt = Date.now() + minutes * 60_000;
    saveForLater({ serverId: server.id, channelId: msg.channel_id, messageId: msg.id, author: msg.author_id, authorName: name, preview: (msg.poll?.question ?? msg.content) || msg.attachments.map((a) => a.filename).join(", "), remindAt });
    toast(remindAt ? t("later.savedRemind", { time: fmtFull(remindAt) }) : t("later.saved"), undefined, "ok", 2500);
  };
  const isSaved = settings.value.saved.some((x) => x.serverId === server.id && x.messageId === msg.id);

  return (
    <div
      id={`msg-${msg.id}`}
      class={`msg${compact ? "" : " first"}${mentioned ? " mentioned" : ""}${msg.pending ? " pending" : ""}${msg.failed ? " failed" : ""}${msg.pinned_at && !compact ? " pinned-mark" : ""}`}
      onContextMenu={msg.pending ? undefined : menu}
    >
      <div class="gutter">
        {compact ? (
          <div class="time" title={fmtFull(msg.created_at)}>{fmtTime(msg.created_at)}</div>
        ) : (
          <div style={{ cursor: "pointer" }} onClick={() => author && openModal(<ProfileCard server={server} member={author} />)} onContextMenu={authorMenu}>
            <Avatar server={server} userId={msg.author_id} name={name} size={38} />
          </div>
        )}
      </div>
      <div class="msg-body">
        {msg.reply_preview && (
          <div class="msg-reply" onClick={() => (jumpTarget.value = { serverId: server.id, channelId: msg.channel_id, messageId: msg.reply_preview!.id })}>
            <Icon.Reply size={13} class="flip" />
            <b>{server.memberName(msg.reply_preview.author_id)}</b>
            <span class="ellipsis">{msg.reply_preview.content}</span>
          </div>
        )}
        {!compact && (
          <div class="msg-meta">
            <span class="msg-author" style={color ? { color } : undefined} onClick={() => author && openModal(<ProfileCard server={server} member={author} />)} onContextMenu={authorMenu}>
              {name}
            </span>
            {timeoutActive(author) && <span class="timeout-mark" title={t("mod.timeoutUntil", { time: fmtFull(author!.timeout_until!) })}><Icon.Clock size={12} /></span>}
            <span class="msg-time" title={fmtFull(msg.created_at)}>{fmtStamp(msg.created_at)}</span>
          </div>
        )}
        {msg.forwarded_from != null && (
          <div class="msg-forwarded">
            <Icon.Forward size={13} /> {t("fwd.label", { name: server.memberName(msg.forwarded_from) })}
          </div>
        )}
        {msg.poll ? (
          <PollView server={server} msg={msg} poll={msg.poll} me={me} canVote={canReact || !!server.dm(msg.channel_id)} />
        ) : editing ? (
          <div class="composer" style={{ marginTop: "4px" }}>
            <textarea
              value={draft}
              autoFocus
              rows={Math.min(10, draft.split("\n").length + 1)}
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(null);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <div class="faint xs" style={{ padding: "0 8px 6px" }}>{t("chat.editHint")}</div>
          </div>
        ) : (
          msg.content && (
            <div class="msg-text">
              <Markdown text={msg.content} server={server} />
              {msg.edited_at && <span class="msg-edited" title={fmtFull(msg.edited_at)}> ({t("chat.edited")})</span>}
            </div>
          )
        )}
        {msg.failed && (
          <div class="row xs" style={{ marginTop: "2px" }}>
            <span class="error-text">{t("chat.sendFailed")}</span>
            <button class="btn sm ghost" onClick={() => server.discardFailed(msg.channel_id, msg.nonce!)}>{t("chat.discard")}</button>
          </div>
        )}
        {msg.attachments.length > 0 && (
          <div class="attachments">
            {msg.attachments.map((a) =>
              a.mime.startsWith("image/") ? <LazyImage key={a.id} server={server} att={a} /> : a.mime.startsWith("audio/") ? <AudioMessage key={a.id} server={server} att={a} /> : <FileCard key={a.id} server={server} att={a} />,
            )}
          </div>
        )}
        {msg.reactions.length > 0 && (
          <div class="reactions">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                class={`reaction${r.users.includes(me) ? " mine" : ""}`}
                title={r.users.map((u) => server.memberName(u)).join(", ")}
                disabled={!canReact}
                onClick={() => react(r.emoji)}
              >
                <span class="e">{r.emoji}</span>
                {r.users.length}
              </button>
            ))}
            {canReact && (
              <button class="reaction" title={t("chat.addReaction")} onClick={(e) => setPicker((e.currentTarget as HTMLElement).getBoundingClientRect())}>
                <Icon.Smile size={13} />
              </button>
            )}
          </div>
        )}
      </div>
      {!msg.pending && !editing && (
        <div class="msg-actions">
          {canReact && QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} class="icon-btn sm" title={e} onClick={() => react(e)} style={{ fontSize: "14px" }}>{e}</button>
          ))}
          {canReact && <IconButton title={t("chat.addReaction")} class="sm" onClick={(e) => setPicker((e.currentTarget as HTMLElement).getBoundingClientRect())}><Icon.Smile /></IconButton>}
          <IconButton title={t("chat.reply")} class="sm" onClick={() => onReply(msg)}><Icon.Reply class="icon flip" /></IconButton>
          {own && !msg.poll && <IconButton title={t("common.edit")} class="sm" onClick={() => { setDraft(msg.content); setEditing(msg.id); }}><Icon.Edit /></IconButton>}
          {!msg.poll && <IconButton title={t("fwd.action")} class="sm" onClick={() => openModal(<ForwardDialog server={server} msg={msg} />)}><Icon.Forward /></IconButton>}
          <IconButton title={t("chat.more")} class="sm" onClick={(e) => menu(e as unknown as MouseEvent)}><Icon.More /></IconButton>
          {canPin && <IconButton title={msg.pinned_at ? t("chat.unpin") : t("chat.pin")} class="sm" active={!!msg.pinned_at} onClick={pin}><Icon.Pin /></IconButton>}
          {(own || canManage) && <IconButton title={t("common.delete")} class="sm on-danger" onClick={remove}><Icon.Trash /></IconButton>}
        </div>
      )}
      {picker && (
        <EmojiPicker
          anchor={picker}
          onClose={() => setPicker(null)}
          onPick={(e) => {
            setPicker(null);
            react(e);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- composer

interface PendingFile {
  file: File;
  progress: number;
}

function Composer({ server, channelId, reply, clearReply, onEditLast }: { server: ServerStore; channelId: number; reply: Message | null; clearReply: () => void; onEditLast: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [sending, setSending] = useState(false);
  const [ac, setAc] = useState<{ query: string; index: number } | null>(null);
  const [emoji, setEmoji] = useState<DOMRect | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const perms = server.channelPerms(channelId);
  const canSend = has(perms, P.SEND_MESSAGES);
  const canAttach = has(perms, P.ATTACH_FILES) && (server.info.value?.uploads_enabled ?? false);
  const maxLen = server.info.value?.max_message_len ?? 4000;
  const maxUpload = (server.info.value?.max_upload_mb ?? 25) * 1024 * 1024;
  const ch = server.channel(channelId);
  const dm = server.dm(channelId);
  const meMember = server.me.value ? server.member(server.me.value.id) : undefined;
  const timedOut = !dm && timeoutActive(meMember);
  const slow = ch?.slowmode ?? 0;
  const slowExempt = has(perms, P.MANAGE_MESSAGES);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);
  const placeholder = timedOut
    ? t("mod.youTimedOut", { time: fmtTime(meMember!.timeout_until!) })
    : !canSend
      ? t("chat.noSendPerm")
      : cooldown > 0
        ? t("chat.slowWait", { s: cooldown })
        : ch
          ? t("chat.placeholderChannel", { name: ch.name })
          : dm
            ? t("chat.placeholderDm", { name: server.memberName(dm.user_id) })
            : t("chat.placeholder");

  useEffect(() => {
    ta.current?.focus();
  }, [channelId, reply]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  useEffect(() => {
    if (insertText.value === null) return;
    const el = ta.current;
    const ins = insertText.value;
    insertText.value = null;
    if (!el) return setText((x) => x + ins);
    const a = el.selectionStart;
    const next = text.slice(0, a) + ins + text.slice(el.selectionEnd);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + ins.length, a + ins.length);
    });
  }, [insertText.value]);

  const sendVoice = async (file: File) => {
    if (!canAttach) return toast(t("chat.noAttach"), t("chat.noAttachBody"), "warn");
    setSending(true);
    try {
      const id = await server.upload(channelId, file, () => {});
      const replyId = reply?.id ?? null;
      clearReply();
      await server.send(channelId, "", replyId, [id]);
    } catch (e) {
      toast(t("chat.sendFailed"), errorText(e), "error");
    } finally {
      setSending(false);
    }
  };
  const voiceRec = useRecorder((f) => void sendVoice(f));
  const addFiles = (list: File[]) => {
    if (!canAttach) return toast(t("chat.noAttach"), t("chat.noAttachBody"), "warn");
    const ok: PendingFile[] = [];
    for (const f of list) {
      if (f.size > maxUpload) toast(t("chat.fileTooLarge"), t("chat.fileTooLargeBody", { name: f.name, size: fmtBytes(f.size), max: fmtBytes(maxUpload) }), "warn");
      else ok.push({ file: f, progress: 0 });
    }
    setFiles((cur) => [...cur, ...ok].slice(0, 10));
  };
  useEffect(() => {
    if (droppedFiles.value.length) {
      addFiles(droppedFiles.value);
      droppedFiles.value = [];
    }
  }, [droppedFiles.value]);

  const candidates = useMemo(() => {
    if (!ac) return [];
    const q = ac.query.toLowerCase();
    return [...server.members.value.values()].filter((m) => m.username.toLowerCase().startsWith(q) || m.display_name.toLowerCase().startsWith(q)).slice(0, 8);
  }, [ac?.query, server.members.value]);

  const updateAc = (value: string, caret: number) => {
    const m = /(^|\s)@([A-Za-z0-9_.-]{0,32})$/.exec(value.slice(0, caret));
    setAc(m ? { query: m[2], index: 0 } : null);
  };

  const pickMention = (m: Member) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([A-Za-z0-9_.-]{0,32})$/, `@${m.username} `);
    setText(before + text.slice(caret));
    setAc(null);
    requestAnimationFrame(() => el.setSelectionRange(before.length, before.length));
  };

  const send = async () => {
    const content = text.trim();
    if ((!content && !files.length) || sending) return;
    if (content.length > maxLen) return toast(t("chat.tooLong"), t("chat.tooLongBody", { max: maxLen }), "warn");
    setSending(true);
    try {
      const ids: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const id = await server.upload(channelId, files[i].file, (p) => setFiles((cur) => cur.map((f, j) => (j === i ? { ...f, progress: p } : f))));
        ids.push(id);
      }
      setText("");
      setFiles([]);
      const replyId = reply?.id ?? null;
      clearReply();
      if (slow > 0 && !slowExempt) setCooldown(slow);
      await server.send(channelId, content, replyId, ids);
    } catch (e) {
      toast(t("chat.sendFailed"), errorText(e), "error");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (ac && candidates.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const d = e.key === "ArrowDown" ? 1 : -1;
        setAc({ ...ac, index: (ac.index + d + candidates.length) % candidates.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(candidates[ac.index]);
        return;
      }
      if (e.key === "Escape") return setAc(null);
    }
    if ((e.ctrlKey || e.metaKey) && ["b", "i", "u"].includes(e.key.toLowerCase()) && ta.current) {
      e.preventDefault();
      wrapSelection(ta.current, { b: "**", i: "*", u: "__" }[e.key.toLowerCase()]!, setText);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (cooldown <= 0) void send();
    } else if (e.key === "Escape" && reply) clearReply();
    else if (e.key === "ArrowUp" && !text) {
      e.preventDefault();
      onEditLast();
    }
  };

  const onInput = (e: Event) => {
    const el = e.target as HTMLTextAreaElement;
    setText(el.value);
    updateAc(el.value, el.selectionStart);
    if (el.value && Date.now() - lastTyping.current > 4000 && canSend) {
      lastTyping.current = Date.now();
      server.rpc("typing", { channel_id: channelId }).catch(() => {});
    }
  };

  const typingUsers = Object.keys(server.typing.value[channelId] ?? {})
    .map(Number)
    .filter((u) => u !== server.me.value?.id)
    .map((u) => server.memberName(u));

  return (
    <div class="composer-wrap">
      {ac && candidates.length > 0 && (
        <div class="autocomplete" role="listbox">
          {candidates.map((m, i) => (
            <button key={m.id} class={i === ac.index ? "sel" : ""} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
              <Avatar server={server} userId={m.id} name={m.display_name || m.username} size={22} />
              <span>{m.display_name || m.username}</span>
              <span class="faint small">@{m.username}</span>
            </button>
          ))}
        </div>
      )}
      <div class="composer">
        {reply && (
          <div class="composer-bar">
            <Icon.Reply size={15} class="icon flip" />
            <span class="grow ellipsis">
              {t("chat.replyingTo")} <b>{server.memberName(reply.author_id)}</b>: {reply.content}
            </span>
            <IconButton title={t("chat.cancelReply")} class="sm" onClick={clearReply}><Icon.X /></IconButton>
          </div>
        )}
        {files.length > 0 && (
          <div class="pending-files">
            {files.map((f, i) => (
              <div class="pending-file" key={i}>
                <Icon.File size={16} />
                <div class="grow" style={{ minWidth: "0px" }}>
                  <div class="ellipsis">{f.file.name}</div>
                  <div class="faint xs">{fmtBytes(f.file.size)}</div>
                  {sending && <ProgressBar value={f.progress} />}
                </div>
                {!sending && <IconButton title={t("common.remove")} class="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon.X /></IconButton>}
              </div>
            ))}
          </div>
        )}
        {voiceRec.recording && (
          <div class="rec-bar" role="status">
            <span class="rec-dot" />
            <span class="rec-time">{fmtClock((Date.now() - voiceRec.recording.start) / 1000)}</span>
            <div class="rec-level">
              {Array.from({ length: 32 }, (_, i) => voiceRec.recording!.level[i - (32 - voiceRec.recording!.level.length)] ?? 0).map((v, i) => (
                <i key={i} style={{ height: `${Math.max(8, Math.round(v * 100))}%` }} />
              ))}
            </div>
            <span class="grow faint xs">{t("vm.recording")}</span>
            <IconButton title={t("vm.cancel")} class="sm on-danger" onClick={() => voiceRec.stop(true)}><Icon.Trash /></IconButton>
            <button class="btn sm primary" onClick={() => voiceRec.stop(false)}><Icon.Send size={14} class="icon flip" /> {t("vm.send")}</button>
          </div>
        )}
        <div class="composer-row">
          {canSend && (
            <IconButton
              title={t("chat.plus")}
              disabled={sending}
              onClick={(e) =>
                showMenu(e as unknown as MouseEvent, [
                  ...(canAttach ? [{ label: t("chat.attach"), onClick: async () => addFiles(await pickFiles()) }] : []),
                  { label: t("poll.create"), onClick: () => openModal(<PollDialog server={server} channelId={channelId} />) },
                ])
              }
            >
              <Icon.Plus />
            </IconButton>
          )}
          <textarea
            ref={ta}
            rows={1}
            value={text}
            placeholder={placeholder}
            disabled={!canSend}
            maxLength={maxLen + 100}
            aria-label={placeholder}
            onInput={onInput}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              const fl = Array.from(e.clipboardData?.files ?? []);
              if (fl.length) {
                e.preventDefault();
                addFiles(fl);
              }
            }}
          />
          {text.length > maxLen - 200 && <span class={`xs ${text.length > maxLen ? "error-text" : "faint"}`} style={{ padding: "0 4px 10px" }}>{maxLen - text.length}</span>}
          {canSend && (
            <IconButton title={t("chat.emoji")} onClick={(e) => setEmoji((e.currentTarget as HTMLElement).getBoundingClientRect())}>
              <Icon.Smile />
            </IconButton>
          )}
          {canSend && canAttach && !text.trim() && !files.length && !voiceRec.recording ? (
            <IconButton title={t("vm.record")} disabled={sending || cooldown > 0} onClick={() => void voiceRec.start()}>
              {sending ? <Spinner /> : <Icon.Mic />}
            </IconButton>
          ) : (
            <IconButton title={t("chat.send")} disabled={!canSend || sending || cooldown > 0 || (!text.trim() && !files.length)} onClick={() => void send()}>
              {sending ? <Spinner /> : <Icon.Send class="icon flip" />}
            </IconButton>
          )}
        </div>
      </div>
      {emoji && (
        <EmojiPicker
          anchor={emoji}
          onClose={() => setEmoji(null)}
          onPick={(e) => {
            setEmoji(null);
            insertText.value = e;
          }}
        />
      )}
      {slow > 0 && canSend && (
        <div class="slowmode-hint" title={slowExempt ? t("chat.slowExempt") : undefined}>
          <Icon.Clock size={12} /> {t("chat.slowmode", { d: fmtSlow(slow) })}{slowExempt ? ` · ${t("chat.slowExemptShort")}` : ""}
        </div>
      )}
      <div class="typing" aria-live="polite">
        {typingUsers.length === 1 && t("chat.typing1", { name: typingUsers[0] })}
        {typingUsers.length === 2 && t("chat.typing2", { a: typingUsers[0], b: typingUsers[1] })}
        {typingUsers.length > 2 && t("chat.typingMany")}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- side panels

function jumpTo(server: ServerStore, m: Message) {
  if (server.dm(m.channel_id)) openDm(server, m.channel_id);
  else {
    selectServer(server.id);
    selectChannel(m.channel_id);
  }
  jumpTarget.value = { serverId: server.id, channelId: m.channel_id, messageId: m.id };
}

function ResultList({ server, title, load, onClose, empty }: { server: ServerStore; title: string; load: () => Promise<Message[]>; onClose: () => void; empty: string }) {
  const [results, setResults] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setResults(null);
    setErr(null);
    load().then(setResults, (e) => setErr(errorText(e)));
  }, [title]);
  return (
    <aside class="members" style={{ width: "330px" }} aria-label={title}>
      <div class="row" style={{ padding: "4px 4px 8px" }}>
        <b class="grow ellipsis">{title}</b>
        <IconButton title={t("common.close")} onClick={onClose}><Icon.X /></IconButton>
      </div>
      {err && <div class="error-text" style={{ padding: "8px" }}>{err}</div>}
      {!results && !err && <div style={{ padding: "12px" }}><Spinner /></div>}
      {results && !results.length && <div class="faint small" style={{ padding: "8px" }}>{empty}</div>}
      {results?.map((m) => (
        <div key={m.id} class="list-item" style={{ alignItems: "flex-start" }} onClick={() => jumpTo(server, m)}>
          <Avatar server={server} userId={m.author_id} name={server.memberName(m.author_id)} size={28} />
          <div class="grow" style={{ minWidth: "0px" }}>
            <div class="row small">
              <b class="ellipsis">{server.memberName(m.author_id)}</b>
              <span class="faint xs">{server.channel(m.channel_id) ? `#${server.channel(m.channel_id)!.name}` : "DM"} · {fmtStamp(m.created_at)}</span>
            </div>
            <div class="small muted" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: "80px", overflow: "hidden" }}>{m.content}</div>
          </div>
        </div>
      ))}
    </aside>
  );
}

/** Inbox: mentions on this server and messages saved for later (with reminders). */
function InboxPanel({ server, onClose }: { server: ServerStore; onClose: () => void }) {
  const [tab, setTab] = useState<"mentions" | "later">("mentions");
  const [mentions, setMentions] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== "mentions") return;
    setMentions(null);
    server.rpc<{ messages: Message[] }>("mention.list", {}).then((r) => setMentions(r.messages), (e) => setErr(errorText(e)));
  }, [tab]);
  const saved = settings.value.saved;
  const jumpSaved = (x: (typeof saved)[number]) => {
    const s = server.id === x.serverId ? server : null;
    if (!s) return;
    if (s.dm(x.channelId)) openDm(s, x.channelId);
    else {
      selectServer(s.id);
      selectChannel(x.channelId);
    }
    jumpTarget.value = { serverId: x.serverId, channelId: x.channelId, messageId: x.messageId };
  };
  return (
    <aside class="members inbox" style={{ width: "340px" }} aria-label={t("inbox.title")}>
      <div class="row" style={{ padding: "4px 4px 8px" }}>
        <b class="grow">{t("inbox.title")}</b>
        <IconButton title={t("common.close")} onClick={onClose}><Icon.X /></IconButton>
      </div>
      <div class="tabs" style={{ marginBottom: "8px" }}>
        <button class={tab === "mentions" ? "active" : ""} onClick={() => setTab("mentions")}>{t("inbox.mentions")}</button>
        <button class={tab === "later" ? "active" : ""} onClick={() => setTab("later")}>{t("inbox.later")} {saved.length > 0 && <span class="badge">{saved.length}</span>}</button>
      </div>
      {tab === "mentions" && (
        <>
          {err && <div class="error-text" style={{ padding: "8px" }}>{err}</div>}
          {!mentions && !err && <div style={{ padding: "12px" }}><Spinner /></div>}
          {mentions && !mentions.length && <div class="empty-hint">{t("inbox.noMentions")}</div>}
          {mentions?.map((m) => (
            <div key={m.id} class="list-item" style={{ alignItems: "flex-start" }} onClick={() => jumpTo(server, m)}>
              <Avatar server={server} userId={m.author_id} name={server.memberName(m.author_id)} size={28} />
              <div class="grow" style={{ minWidth: "0px" }}>
                <div class="row small">
                  <b class="ellipsis">{server.memberName(m.author_id)}</b>
                  <span class="faint xs">{server.channel(m.channel_id) ? `#${server.channel(m.channel_id)!.name}` : "DM"} · {fmtStamp(m.created_at)}</span>
                </div>
                <div class="small muted inbox-text">{m.content}</div>
              </div>
            </div>
          ))}
        </>
      )}
      {tab === "later" && (
        <>
          {!saved.length && <div class="empty-hint">{t("inbox.noLater")}</div>}
          {saved.map((x) => {
            const here = x.serverId === server.id;
            return (
              <div key={`${x.serverId}:${x.messageId}`} class={`list-item${here ? "" : " dim"}`} style={{ alignItems: "flex-start" }} onClick={() => here && jumpSaved(x)}>
                <div class="grow" style={{ minWidth: "0px" }}>
                  <div class="row small">
                    <b class="ellipsis">{x.authorName}</b>
                    <span class="faint xs">{here ? (server.channel(x.channelId) ? `#${server.channel(x.channelId)!.name}` : "DM") : t("inbox.otherServer")}</span>
                  </div>
                  <div class="small muted inbox-text">{x.preview}</div>
                  {x.remindAt && <div class="xs reminder-chip"><Icon.Clock size={11} /> {fmtFull(x.remindAt)}</div>}
                </div>
                <IconButton title={t("later.remove")} class="sm" onClick={(e) => { e.stopPropagation(); removeSaved(x.serverId, x.messageId); }}><Icon.Check /></IconButton>
              </div>
            );
          })}
        </>
      )}
    </aside>
  );
}

// ------------------------------------------------------------- chat view

export function ChatView({ server, channelId }: { server: ServerStore; channelId: number }) {
  const log = server.log(channelId);
  const msgs = log.messages.value;
  const me = server.me.value?.id ?? -1;
  const ch = server.channel(channelId);
  const dm = server.dm(channelId);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [reply, setReply] = useState<Message | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [panel, setPanel] = useState<{ kind: "search"; q: string } | { kind: "pins" } | { kind: "inbox" } | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const unreadFrom = useRef<number>(server.readStates.value[channelId] ?? 0);
  const perms = server.channelPerms(channelId);
  const canManage = has(perms, P.MANAGE_MESSAGES);
  const canPin = canManage || !!dm;
  const canReact = has(perms, P.SEND_MESSAGES);
  const ready = server.conn.state.value === "ready";

  useEffect(() => {
    if (ready) void server.loadInitial(channelId).catch((e) => toast(t("chat.historyFailed"), errorText(e), "error"));
  }, [channelId, ready]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length, msgs[msgs.length - 1]?.id]);

  const hold = unreadHold.value;
  const holding = !!hold && hold.serverId === server.id && hold.channelId === channelId;
  if (holding) unreadFrom.current = hold.from;
  useEffect(() => () => {
    if (unreadHold.value?.channelId === channelId) unreadHold.value = null;
  }, [channelId]);
  useEffect(() => {
    if (!holding && stick.current && windowFocused.value && ready && msgs.length) void server.ack(channelId);
  }, [msgs.length, windowFocused.value, ready, holding]);

  useEffect(() => {
    const j = jumpTarget.value;
    if (!j || j.serverId !== server.id || j.channelId !== channelId) return;
    (async () => {
      try {
        await server.loadAround(channelId, j.messageId);
      } catch {
        /* ignore */
      }
      requestAnimationFrame(() => {
        const el = document.getElementById(`msg-${j.messageId}`);
        if (el) {
          stick.current = false;
          el.scrollIntoView({ block: "center" });
          el.classList.add("highlight");
          setTimeout(() => el.classList.remove("highlight"), 1700);
        } else toast(t("chat.notFound"), t("chat.notFoundBody"), "warn");
        jumpTarget.value = null;
      });
    })();
  }, [jumpTarget.value]);

  const onScroll = async () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick.current && windowFocused.value && !holding) void server.ack(channelId);
    if (el.scrollTop < 150 && log.hasMore.value && !log.loading.value && log.loaded) {
      const prevHeight = el.scrollHeight;
      const n = await server.loadOlder(channelId).catch(() => 0);
      if (n) requestAnimationFrame(() => (el.scrollTop += el.scrollHeight - prevHeight));
    }
  };

  const editLast = () => {
    const last = [...msgs].reverse().find((m) => m.author_id === me && !m.pending);
    if (last) setEditing(last.id);
  };

  const title = ch ? ch.name : dm ? server.memberName(dm.user_id) : "";
  const inDmCall = dm && server.voiceMembers(channelId).length > 0;
  const v = voice.value;
  const inThisCall = v && v.server === server && v.channelId === channelId;

  let lastDay = "";
  let unreadShown = false;
  const items: ComponentChildren[] = [];
  msgs.forEach((m, i) => {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      items.push(<div class="day-sep" key={`d-${m.created_at}-${i}`}>{day}</div>);
      lastDay = day;
    }
    if (!unreadShown && (unreadFrom.current || holding) && m.id > unreadFrom.current && m.author_id !== me && !m.pending) {
      unreadShown = true;
      items.push(<div class="unread-sep" key="unread">{t("chat.new")}</div>);
    }
    const prev = msgs[i - 1];
    const compact =
      !!prev && prev.author_id === m.author_id && m.created_at - prev.created_at < GROUP_MS && fmtDay(prev.created_at) === day && !m.reply_preview && !(unreadShown && prev.id <= unreadFrom.current);
    items.push(
      <MessageItem
        key={m.nonce ?? m.id}
        server={server}
        msg={m}
        compact={compact}
        me={me}
        canManage={canManage}
        canPin={canPin}
        canReact={canReact}
        onReply={setReply}
        editing={editing === m.id}
        setEditing={setEditing}
      />,
    );
  });

  return (
    <div class="content" style={{ flexDirection: "row" }}>
      <div class="content">
        <header class="main-head">
          <div class="chan-title">
            {dm ? <Avatar server={server} userId={dm.user_id} name={title} size={24} presence={server.member(dm.user_id)?.presence} /> : <Icon.Hash />}
            <span class="ellipsis">{title}</span>
          </div>
          {ch?.topic ? <div class="topic ellipsis grow">{ch.topic}</div> : <div class="grow" />}
          {dm && (
            <IconButton title={inThisCall ? t("chat.inCall") : inDmCall ? t("chat.joinCall") : t("chat.startCall")} active={!!inThisCall} onClick={() => void joinVoice(server, channelId)}>
              <Icon.Speaker />
            </IconButton>
          )}
          <IconButton title={t("chat.pins")} active={panel?.kind === "pins"} onClick={() => setPanel(panel?.kind === "pins" ? null : { kind: "pins" })}>
            <Icon.Pin />
          </IconButton>
          <IconButton title={t("inbox.title")} active={panel?.kind === "inbox"} onClick={() => setPanel(panel?.kind === "inbox" ? null : { kind: "inbox" })}>
            <Icon.Inbox />
            {settings.value.saved.some((x) => x.remindAt) && <span class="dot-badge" />}
          </IconButton>
          <div class="search-box">
            <input
              class="input"
              placeholder={t("chat.search")}
              aria-label={t("chat.searchLabel")}
              value={searchInput}
              onInput={(e) => setSearchInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchInput.trim()) setPanel({ kind: "search", q: searchInput.trim() });
                if (e.key === "Escape") {
                  setPanel(null);
                  setSearchInput("");
                }
              }}
            />
          </div>
          {ch && (
            <IconButton title={settings.value.showMembers ? t("chat.hideMembers") : t("chat.showMembers")} active={settings.value.showMembers} onClick={() => updateSettings({ showMembers: !settings.value.showMembers })}>
              <Icon.Users />
            </IconButton>
          )}
        </header>
        {inDmCall && !inThisCall && (
          <div class="conn-banner ok">
            <span class="grow">{t("chat.callRunning")}</span>
            <button class="btn sm" onClick={() => void joinVoice(server, channelId)}>{t("chat.join")}</button>
          </div>
        )}
        {inThisCall && v && (v.screens.value.size > 0 || v.cameras.value.size > 0) && <CallStrip />}
        <div
          class="messages"
          ref={scroller}
          onScroll={onScroll}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const fl = Array.from(e.dataTransfer?.files ?? []);
            if (fl.length) droppedFiles.value = fl;
          }}
          style={dragging ? { outline: "1.5px dashed var(--accent)", outlineOffset: "-8px" } : undefined}
        >
          {!log.hasMore.value && log.loaded && (
            <div class="msg-start">
              <h1>{dm ? title : t("chat.welcome", { name: title })}</h1>
              <div class="muted">{dm ? t("chat.dmStart", { name: title }) : t("chat.channelStart")}</div>
            </div>
          )}
          {log.loading.value && <div class="load-more"><Spinner /></div>}
          {items}
        </div>
        <Composer server={server} channelId={channelId} reply={reply} clearReply={() => setReply(null)} onEditLast={editLast} />
      </div>
      {panel?.kind === "search" && (
        <ResultList
          server={server}
          title={t("chat.searchTitle", { q: panel.q })}
          empty={t("chat.noResults")}
          load={() => server.rpc<{ messages: Message[] }>("message.search", { query: panel.q }).then((r) => r.messages)}
          onClose={() => {
            setPanel(null);
            setSearchInput("");
          }}
        />
      )}
      {panel?.kind === "inbox" && <InboxPanel server={server} onClose={() => setPanel(null)} />}
      {panel?.kind === "pins" && (
        <ResultList
          server={server}
          title={t("chat.pins")}
          empty={t("chat.noPins")}
          load={() => server.rpc<{ messages: Message[] }>("message.pins", { channel_id: channelId }).then((r) => r.messages)}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}

/** Small video strip shown above a DM conversation during a call. */
function CallStrip() {
  const v = voice.value!;
  const tiles = [...v.screens.value.entries(), ...v.cameras.value.entries()];
  return (
    <div class="voice-strip" style={{ paddingTop: "10px", background: "var(--bg-0)" }}>
      {tiles.map(([uid, stream], i) => (
        <VideoTile key={`${uid}-${i}`} stream={stream} label={v.server.memberName(uid)} muted />
      ))}
    </div>
  );
}

function fmtSlow(s: number) {
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
}

export function VideoTile({ stream, label, muted, onClick, children }: { stream: MediaStream; label: string; muted?: boolean; onClick?: () => void; children?: ComponentChildren }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div class="tile screen" onClick={onClick}>
      <video ref={ref} autoPlay playsInline muted={muted ?? true} />
      {label && <div class="tile-label">{label}</div>}
      {children}
    </div>
  );
}

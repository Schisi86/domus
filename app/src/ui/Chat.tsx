// Text channel / DM view: header, message history, composer, search, pins.

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { lightbox, openDm, openModal, selectChannel, selectServer, settings, showMenu, startDm, toast, updateSettings, windowFocused } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Attachment, Member, Message } from "../types";
import { has, P } from "../types";
import { errorText, fmtBytes, fmtDay, fmtFull, fmtStamp, fmtTime, t } from "../i18n";
import { Avatar, IconButton, Icon, ProgressBar, Spinner, confirmDialog, copyText, loadBlobUrl } from "./components";
import { transport } from "../net/transport";
import { pickFiles } from "../platform";
import { joinVoice, voice } from "../rtc/voice";
import { ProfileCard } from "./Members";
import { Markdown, wrapSelection } from "./markdown";
import { EmojiPicker } from "./EmojiPicker";

export const jumpTarget = signal<{ serverId: string; channelId: number; messageId: number } | null>(null);
/** Files dropped onto the message list, picked up by the composer. */
const droppedFiles = signal<File[]>([]);
/** Text inserted by the emoji picker of the composer. */
const insertText = signal<string | null>(null);
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
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      { label: t("chat.reply"), onClick: () => onReply(msg) },
      ...(canReact ? [{ label: t("chat.addReaction"), onClick: () => setPicker((e.target as HTMLElement).getBoundingClientRect()) }] : []),
      { label: t("chat.copyText"), onClick: () => copyText(msg.content) },
      ...(own ? [{ label: t("common.edit"), onClick: () => { setDraft(msg.content); setEditing(msg.id); } }] : []),
      ...(canPin ? [{ label: msg.pinned_at ? t("chat.unpin") : t("chat.pin"), onClick: pin }] : []),
      ...(!own ? [{ label: t("member.sendDm"), onClick: () => void startDm(server, msg.author_id).catch((er) => toast(t("common.error"), errorText(er), "error")) }] : []),
      { label: t("chat.copyId"), onClick: () => copyText(String(msg.id)) },
      ...(own || canManage ? [{ separator: true, label: "" }, { label: t("common.delete"), danger: true, onClick: remove }] : []),
    ]);

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
          <div style={{ cursor: "pointer" }} onClick={() => author && openModal(<ProfileCard server={server} member={author} />)}>
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
            <span class="msg-author" style={color ? { color } : undefined} onClick={() => author && openModal(<ProfileCard server={server} member={author} />)}>
              {name}
            </span>
            <span class="msg-time" title={fmtFull(msg.created_at)}>{fmtStamp(msg.created_at)}</span>
          </div>
        )}
        {editing ? (
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
            {msg.attachments.map((a) => (a.mime.startsWith("image/") ? <LazyImage key={a.id} server={server} att={a} /> : <FileCard key={a.id} server={server} att={a} />))}
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
          {own && <IconButton title={t("common.edit")} class="sm" onClick={() => { setDraft(msg.content); setEditing(msg.id); }}><Icon.Edit /></IconButton>}
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
  const placeholder = !canSend ? t("chat.noSendPerm") : ch ? t("chat.placeholderChannel", { name: ch.name }) : dm ? t("chat.placeholderDm", { name: server.memberName(dm.user_id) }) : t("chat.placeholder");

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
      void send();
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
        <div class="composer-row">
          {canAttach && (
            <IconButton title={t("chat.attach")} disabled={!canSend || sending} onClick={async () => addFiles(await pickFiles())}>
              <Icon.Paperclip />
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
          <IconButton title={t("chat.send")} disabled={!canSend || sending || (!text.trim() && !files.length)} onClick={() => void send()}>
            {sending ? <Spinner /> : <Icon.Send class="icon flip" />}
          </IconButton>
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
  const [panel, setPanel] = useState<{ kind: "search"; q: string } | { kind: "pins" } | null>(null);
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

  useEffect(() => {
    if (stick.current && windowFocused.value && ready && msgs.length) void server.ack(channelId);
  }, [msgs.length, windowFocused.value, ready]);

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
    if (stick.current && windowFocused.value) void server.ack(channelId);
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
    if (!unreadShown && unreadFrom.current && m.id > unreadFrom.current && m.author_id !== me && !m.pending) {
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

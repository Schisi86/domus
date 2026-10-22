// Text channel / DM view: header, message history, composer, search.

import { signal } from "@preact/signals";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { lightbox, openDm, selectChannel, selectServer, settings, showMenu, startDm, toast, updateSettings, windowFocused } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Attachment, Member, Message } from "../types";
import { has, P } from "../types";
import { errorText, fmtBytes, fmtDay, fmtFull, fmtStamp, fmtTime } from "../i18n";
import { Avatar, IconButton, Icon, ProgressBar, Spinner, confirmDialog, copyText, loadBlobUrl } from "./components";
import { transport } from "../net/transport";
import { isTauri, pickFiles } from "../platform";
import { joinVoice, voice } from "../rtc/voice";
import { ProfileCard } from "./Members";
import { openModal } from "../state/app";

export const jumpTarget = signal<{ serverId: string; channelId: number; messageId: number } | null>(null);
/** Files dropped onto the message list, picked up by the composer. */
const droppedFiles = signal<File[]>([]);
const GROUP_MS = 7 * 60 * 1000;

// ------------------------------------------------------------- text rendering

async function openExternal(url: string) {
  if (!/^https?:\/\//i.test(url)) return;
  if (!(await confirmDialog({ title: "Externen Link öffnen?", body: <span class="selectable mono" style={{ wordBreak: "break-all" }}>{url}</span>, confirm: "Öffnen" }))) return;
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}

function renderInline(text: string, server: ServerStore, keyBase: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /(`[^`\n]+`)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(@[A-Za-z0-9_.-]{2,32})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) {
      const url = m[2];
      out.push(
        <a key={k} href={url} onClick={(e) => { e.preventDefault(); void openExternal(url); }}>
          {url}
        </a>,
      );
    } else if (m[3]) {
      const name = m[3].slice(1).replace(/[.-]+$/, "");
      const known = [...server.members.value.values()].some((u) => u.username.toLowerCase() === name.toLowerCase());
      out.push(known ? <span key={k} class="mention">{m[3]}</span> : m[3]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function MessageText({ text, server }: { text: string; server: ServerStore }) {
  const parts = text.split(/```/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? <pre key={i}>{p.replace(/^\w*\n/, "")}</pre> : <span key={i}>{renderInline(p, server, String(i))}</span>,
      )}
    </>
  );
}

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
      const ok = await transport.download(server.target(), `/api/v1/files/${att.id}`, server.token, att.filename, (d, t) => t && setProgress(d / t));
      if (ok) toast("Download abgeschlossen", att.filename, "ok");
    } catch (e) {
      toast("Download fehlgeschlagen", errorText(e), "error");
    } finally {
      setProgress(null);
    }
  };
  return (
    <div class="att-file">
      <Icon.File size={28} />
      <div class="meta">
        <div class="ellipsis" title={att.filename}>{att.filename}</div>
        <div class="faint xs">{fmtBytes(att.size)}</div>
        {progress !== null && <ProgressBar value={progress} />}
      </div>
      <IconButton title="Herunterladen" onClick={download} disabled={progress !== null}>
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
  onReply: (m: Message) => void;
  editing: boolean;
  setEditing: (id: number | null) => void;
}

function MessageItem({ server, msg, compact, me, canManage, onReply, editing, setEditing }: ItemProps) {
  const author: Member | undefined = server.member(msg.author_id);
  const name = server.memberName(msg.author_id);
  const own = msg.author_id === me;
  const mentioned = msg.mentions.includes(me);
  const color = server.roleColor(msg.author_id);
  const [draft, setDraft] = useState(msg.content);

  const remove = async () => {
    if (await confirmDialog({ title: "Nachricht löschen?", body: "Die Nachricht wird für alle endgültig gelöscht.", confirm: "Löschen", danger: true })) {
      server.rpc("message.delete", { message_id: msg.id }).catch((e) => toast("Löschen fehlgeschlagen", errorText(e), "error"));
    }
  };
  const save = async () => {
    const text = draft.trim();
    if (text === msg.content) return setEditing(null);
    try {
      await server.rpc("message.edit", { message_id: msg.id, content: text });
      setEditing(null);
    } catch (e) {
      toast("Bearbeiten fehlgeschlagen", errorText(e), "error");
    }
  };
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      { label: "Antworten", onClick: () => onReply(msg) },
      { label: "Text kopieren", onClick: () => copyText(msg.content) },
      ...(own ? [{ label: "Bearbeiten", onClick: () => { setDraft(msg.content); setEditing(msg.id); } }] : []),
      ...(!own ? [{ label: "Direktnachricht", onClick: () => void startDm(server, msg.author_id).catch((er) => toast("Fehler", errorText(er), "error")) }] : []),
      { label: "Nachrichten-ID kopieren", onClick: () => copyText(String(msg.id)) },
      ...(own || canManage ? [{ separator: true, label: "" }, { label: "Löschen", danger: true, onClick: remove }] : []),
    ]);

  return (
    <div
      id={`msg-${msg.id}`}
      class={`msg${compact ? "" : " first"}${mentioned ? " mentioned" : ""}${msg.pending ? " pending" : ""}${msg.failed ? " failed" : ""}`}
      onContextMenu={msg.pending ? undefined : menu}
    >
      <div class="gutter">
        {compact ? (
          <div class="time" title={fmtFull(msg.created_at)}>{fmtTime(msg.created_at)}</div>
        ) : (
          <div style={{ cursor: "pointer" }} onClick={(e) => author && openModal(<ProfileCard server={server} member={author} anchor={e} />)}>
            <Avatar server={server} userId={msg.author_id} name={name} size={40} />
          </div>
        )}
      </div>
      <div class="msg-body">
        {msg.reply_preview && (
          <div class="msg-reply" style={{ marginLeft: "0px" }} onClick={() => (jumpTarget.value = { serverId: server.id, channelId: msg.channel_id, messageId: msg.reply_preview!.id })}>
            <b>{server.memberName(msg.reply_preview.author_id)}</b>
            <span class="ellipsis">{msg.reply_preview.content}</span>
          </div>
        )}
        {!compact && (
          <div class="msg-meta">
            <span class="msg-author" style={color ? { color } : undefined} onClick={(e) => author && openModal(<ProfileCard server={server} member={author} anchor={e} />)}>
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
            <div class="faint xs" style={{ padding: "0 8px 6px" }}>Esc zum Abbrechen · Enter zum Speichern</div>
          </div>
        ) : (
          msg.content && (
            <div class="msg-text">
              <MessageText text={msg.content} server={server} />
              {msg.edited_at && <span class="msg-edited" title={fmtFull(msg.edited_at)}> (bearbeitet)</span>}
            </div>
          )
        )}
        {msg.failed && (
          <div class="row xs" style={{ marginTop: "2px" }}>
            <span class="error-text">Senden fehlgeschlagen.</span>
            <button class="btn sm ghost" onClick={() => server.discardFailed(msg.channel_id, msg.nonce!)}>Verwerfen</button>
          </div>
        )}
        {msg.attachments.length > 0 && (
          <div class="attachments">
            {msg.attachments.map((a) => (a.mime.startsWith("image/") ? <LazyImage key={a.id} server={server} att={a} /> : <FileCard key={a.id} server={server} att={a} />))}
          </div>
        )}
      </div>
      {!msg.pending && !editing && (
        <div class="msg-actions">
          <IconButton title="Antworten" class="sm" onClick={() => onReply(msg)}><Icon.Reply /></IconButton>
          {own && <IconButton title="Bearbeiten" class="sm" onClick={() => { setDraft(msg.content); setEditing(msg.id); }}><Icon.Edit /></IconButton>}
          <IconButton title="Kopieren" class="sm" onClick={() => copyText(msg.content)}><Icon.Copy /></IconButton>
          {(own || canManage) && <IconButton title="Löschen" class="sm on-danger" onClick={remove}><Icon.Trash /></IconButton>}
        </div>
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
  const ta = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const perms = server.channelPerms(channelId);
  const canSend = has(perms, P.SEND_MESSAGES);
  const canAttach = has(perms, P.ATTACH_FILES) && (server.info.value?.uploads_enabled ?? false);
  const maxLen = server.info.value?.max_message_len ?? 4000;
  const maxUpload = (server.info.value?.max_upload_mb ?? 25) * 1024 * 1024;
  const ch = server.channel(channelId);
  const dm = server.dm(channelId);
  const placeholder = !canSend
    ? "Du hast keine Berechtigung, hier zu schreiben."
    : ch ? `Nachricht an #${ch.name}` : dm ? `Nachricht an @${server.memberName(dm.user_id)}` : "Nachricht";

  useEffect(() => {
    ta.current?.focus();
  }, [channelId, reply]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [text]);

  const addFiles = (list: File[]) => {
    if (!canAttach) return toast("Anhänge nicht möglich", "Auf diesem Kanal oder Server sind Dateiuploads nicht erlaubt.", "warn");
    const ok: PendingFile[] = [];
    for (const f of list) {
      if (f.size > maxUpload) toast("Datei zu groß", `${f.name} (${fmtBytes(f.size)}) überschreitet das Limit von ${fmtBytes(maxUpload)}.`, "warn");
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
    return [...server.members.value.values()]
      .filter((m) => m.username.toLowerCase().startsWith(q) || m.display_name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [ac?.query, server.members.value]);

  const updateAc = (value: string, caret: number) => {
    const m = /(^|\s)@([A-Za-z0-9_.-]{0,32})$/.exec(value.slice(0, caret));
    setAc(m ? { query: m[2], index: 0 } : null);
  };

  const pickMention = (m: Member) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([A-Za-z0-9_.-]{0,32})$/, `@${m.username} `);
    const next = before + text.slice(caret);
    setText(next);
    setAc(null);
    requestAnimationFrame(() => el.setSelectionRange(before.length, before.length));
  };

  const send = async () => {
    const content = text.trim();
    if ((!content && !files.length) || sending) return;
    if (content.length > maxLen) return toast("Nachricht zu lang", `Höchstens ${maxLen} Zeichen.`, "warn");
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
      toast("Senden fehlgeschlagen", errorText(e), "error");
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
            <Icon.Reply size={16} />
            <span class="grow ellipsis">Antwort an <b>{server.memberName(reply.author_id)}</b>: {reply.content}</span>
            <IconButton title="Antwort abbrechen" class="sm" onClick={clearReply}><Icon.X /></IconButton>
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
                {!sending && <IconButton title="Entfernen" class="sm" onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon.X /></IconButton>}
              </div>
            ))}
          </div>
        )}
        <div class="composer-row">
          {canAttach && (
            <IconButton title="Datei anhängen" disabled={!canSend || sending} onClick={async () => addFiles(await pickFiles())}>
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
          <IconButton title="Senden (Enter)" disabled={!canSend || sending || (!text.trim() && !files.length)} onClick={() => void send()}>
            {sending ? <Spinner /> : <Icon.Send />}
          </IconButton>
        </div>
      </div>
      <div class="typing" aria-live="polite">
        {typingUsers.length === 1 && <><b>{typingUsers[0]}</b> schreibt …</>}
        {typingUsers.length === 2 && <><b>{typingUsers[0]}</b> und <b>{typingUsers[1]}</b> schreiben …</>}
        {typingUsers.length > 2 && <>Mehrere Personen schreiben …</>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------- search

function SearchResults({ server, query, onClose }: { server: ServerStore; query: string; onClose: () => void }) {
  const [results, setResults] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setResults(null);
    setErr(null);
    server.rpc<{ messages: Message[] }>("message.search", { query }).then((r) => setResults(r.messages), (e) => setErr(errorText(e)));
  }, [query]);
  const jump = (m: Message) => {
    const isDm = !!server.dm(m.channel_id);
    if (isDm) openDm(server, m.channel_id);
    else {
      selectServer(server.id);
      selectChannel(m.channel_id);
    }
    jumpTarget.value = { serverId: server.id, channelId: m.channel_id, messageId: m.id };
  };
  return (
    <aside class="members" style={{ width: "340px" }} aria-label="Suchergebnisse">
      <div class="row" style={{ padding: "4px 4px 8px" }}>
        <b class="grow">Suche: „{query}“</b>
        <IconButton title="Suche schließen" onClick={onClose}><Icon.X /></IconButton>
      </div>
      {err && <div class="error-text" style={{ padding: "8px" }}>{err}</div>}
      {!results && !err && <div style={{ padding: "12px" }}><Spinner /></div>}
      {results && !results.length && <div class="faint small" style={{ padding: "8px" }}>Keine Treffer.</div>}
      {results?.map((m) => (
        <div key={m.id} class="list-item" style={{ alignItems: "flex-start" }} onClick={() => jump(m)}>
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
  const [search, setSearch] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [dragging, setDragging] = useState(false);
  const unreadFrom = useRef<number>(server.readStates.value[channelId] ?? 0);
  const canManage = has(server.channelPerms(channelId), P.MANAGE_MESSAGES);
  const ready = server.conn.state.value === "ready";

  useEffect(() => {
    if (ready) void server.loadInitial(channelId).catch((e) => toast("Verlauf konnte nicht geladen werden", errorText(e), "error"));
  }, [channelId, ready]);

  // Keep the view pinned to the bottom when new messages arrive.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs.length, msgs[msgs.length - 1]?.id]);

  // Mark as read while the newest messages are visible.
  useEffect(() => {
    if (stick.current && windowFocused.value && ready && msgs.length) void server.ack(channelId);
  }, [msgs.length, windowFocused.value, ready]);

  // Jump to a specific message (search result, reply preview).
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
        } else toast("Nachricht nicht gefunden", "Sie wurde möglicherweise gelöscht.", "warn");
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
      items.push(<div class="unread-sep" key="unread">NEU</div>);
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
          {ch?.topic && <div class="topic ellipsis grow">{ch.topic}</div>}
          {!ch?.topic && <div class="grow" />}
          {dm && (
            <IconButton title={inThisCall ? "Im Anruf" : inDmCall ? "Anruf beitreten" : "Anruf starten"} active={!!inThisCall} onClick={() => void joinVoice(server, channelId)}>
              <Icon.Speaker />
            </IconButton>
          )}
          <div class="search-box">
            <input
              class="input"
              placeholder="Suchen"
              aria-label="Nachrichten durchsuchen"
              value={searchInput}
              onInput={(e) => setSearchInput((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && searchInput.trim()) setSearch(searchInput.trim());
                if (e.key === "Escape") {
                  setSearch(null);
                  setSearchInput("");
                }
              }}
            />
          </div>
          {ch && (
            <IconButton title={settings.value.showMembers ? "Mitgliederliste ausblenden" : "Mitgliederliste einblenden"} active={settings.value.showMembers} onClick={() => updateSettings({ showMembers: !settings.value.showMembers })}>
              <Icon.Users />
            </IconButton>
          )}
        </header>
        {inDmCall && !inThisCall && (
          <div class="conn-banner" style={{ background: "var(--ok)", color: "#fff" }}>
            <span class="grow">Ein Anruf läuft in dieser Unterhaltung.</span>
            <button class="btn sm" onClick={() => void joinVoice(server, channelId)}>Beitreten</button>
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
          style={dragging ? { outline: "2px dashed var(--accent)", outlineOffset: -8 } : undefined}
        >
          {!log.hasMore.value && log.loaded && (
            <div class="msg-start">
              <h1>{dm ? title : `Willkommen in #${title}`}</h1>
              <div class="muted">{dm ? `Das ist der Anfang deiner Direktnachrichten mit ${title}.` : "Das ist der Anfang dieses Kanals."}</div>
            </div>
          )}
          {log.loading.value && <div class="load-more"><Spinner /></div>}
          {items}
        </div>
        <Composer server={server} channelId={channelId} reply={reply} clearReply={() => setReply(null)} onEditLast={editLast} />
      </div>
      {search && <SearchResults server={server} query={search} onClose={() => { setSearch(null); setSearchInput(""); }} />}
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
      <div class="tile-label">{label}</div>
      {children}
    </div>
  );
}

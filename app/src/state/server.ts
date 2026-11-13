// Client-side state of one server connection, updated from the event stream.

import { batch, signal, type Signal } from "@preact/signals";
import { ServerConnection } from "../net/connection";
import { transport, type Target } from "../net/transport";
import type {
  ApiErr, Category, Channel, Dm, IceConfig, Member, Message, Ready, RelKind, Role, SavedServer, ServerInfo, User, VoiceMember,
} from "../types";
import { has, P } from "../types";
import { t } from "../i18n";
import { E2e, isEnvelope } from "../crypto/e2e";
import { settings, updateSettings } from "./app";

export interface ChannelLog {
  messages: Signal<Message[]>;
  hasMore: Signal<boolean>;
  loading: Signal<boolean>;
  loaded: boolean;
  lastUsed: number;
}

/** Messages kept in memory per channel; older ones are reloaded on demand. */
const MAX_CACHED_MESSAGES = 300;
/** Channel histories kept in memory per server (least recently used are dropped). */
const MAX_CACHED_CHANNELS = 16;

const DM_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.CONNECT | P.SPEAK | P.VIDEO | P.SCREEN_SHARE;

export type ServerEventListener = (store: ServerStore, ev: string, d: any) => void;

export class ServerStore {
  readonly id: string;
  saved: Signal<SavedServer>;
  conn: ServerConnection;

  me = signal<User | null>(null);
  info = signal<ServerInfo | null>(null);
  roles = signal<Role[]>([]);
  categories = signal<Category[]>([]);
  channels = signal<Channel[]>([]);
  perms = signal(0);
  isOwner = signal(false);
  members = signal<Map<number, Member>>(new Map());
  dms = signal<Dm[]>([]);
  readStates = signal<Record<number, number>>({});
  mentionCounts = signal<Record<number, number>>({});
  relationships = signal<Map<number, RelKind>>(new Map());
  voice = signal<Map<number, VoiceMember>>(new Map());
  typing = signal<Record<number, Record<number, number>>>({});
  ice: IceConfig | null = null;
  /** End-to-end encryption for direct messages on this server. */
  readonly e2e = new E2e(this);
  /** Keeps encrypted messages in their order of arrival while they are decrypted. */
  private openChain: Promise<void> = Promise.resolve();

  private logs = new Map<number, ChannelLog>();
  private typingTimer: ReturnType<typeof setInterval> | null = null;
  private unknownUsers = new Set<number>();
  private fetchingUsers = false;

  constructor(saved: SavedServer, private listener: ServerEventListener) {
    this.id = saved.id;
    this.saved = signal(saved);
    this.conn = new ServerConnection(saved.id, () => this.target(), () => this.saved.value.token, {
      onReady: (r, reconnect) => this.applyReady(r, reconnect),
      onEvent: (ev, d) => this.onEvent(ev, d),
    });
  }

  target(): Target {
    const s = this.saved.value;
    return { address: s.address, fingerprint: s.fingerprint ?? null };
  }

  get token() {
    return this.saved.value.token ?? "";
  }

  displayName() {
    return this.info.value?.name || this.saved.value.name || this.saved.value.address;
  }

  rpc<T = any>(op: string, d: unknown = {}): Promise<T> {
    return this.conn.rpc<T>(op, d);
  }

  // ------------------------------------------------------------- lookups

  member(uid: number): Member | undefined {
    const m = this.members.value.get(uid);
    if (!m && !this.unknownUsers.has(uid)) {
      this.unknownUsers.add(uid);
      queueMicrotask(() => this.fetchUnknownUsers());
    }
    return m;
  }

  memberName(uid: number): string {
    const m = this.member(uid);
    return m ? m.display_name || m.username : `Benutzer ${uid}`;
  }

  /** Name for a DM; the self-DM is shown as "notes to self". */
  dmName(uid: number): string {
    return uid === this.me.value?.id ? t("home.notes") : this.memberName(uid);
  }

  private async fetchUnknownUsers() {
    if (this.fetchingUsers || !this.conn.ready) return;
    const ids = [...this.unknownUsers].filter((id) => !this.members.value.has(id));
    if (!ids.length) return;
    this.fetchingUsers = true;
    try {
      const users = await this.rpc<Member[]>("user.get", { ids });
      const map = new Map(this.members.value);
      for (const u of users) map.set(u.id, u);
      this.members.value = map;
    } catch {
      /* ignore */
    } finally {
      this.fetchingUsers = false;
    }
  }

  channel(cid: number): Channel | undefined {
    return this.channels.value.find((c) => c.id === cid);
  }

  dm(cid: number): Dm | undefined {
    return this.dms.value.find((d) => d.channel_id === cid);
  }

  channelPerms(cid: number): number {
    const c = this.channel(cid);
    if (c) return c.perms;
    return this.dm(cid) ? DM_PERMS : 0;
  }

  can(p: number) {
    return has(this.perms.value, p);
  }

  roleColor(uid: number): string | undefined {
    const m = this.members.value.get(uid);
    if (!m) return undefined;
    let best: Role | undefined;
    for (const r of this.roles.value) {
      if (r.color && m.roles.includes(r.id) && (!best || r.position > best.position)) best = r;
    }
    return best?.color;
  }

  lastMessageId(cid: number): number | null {
    return this.channel(cid)?.last_message_id ?? this.dm(cid)?.last_message_id ?? null;
  }

  /** A DM that was deleted for me and has no newer message yet. */
  dmHidden(d: Dm): boolean {
    return (d.cleared_before ?? 0) > 0 && (d.last_message_id ?? 0) <= (d.cleared_before ?? 0);
  }

  private patchDm(cid: number, patch: Partial<Dm>) {
    this.dms.value = this.dms.value.map((d) => (d.channel_id === cid ? { ...d, ...patch } : d));
  }

  /** Archive or pin a DM (for me only). */
  async setDmPrefs(cid: number, patch: { archived?: boolean; pinned?: boolean }) {
    this.patchDm(cid, patch);
    await this.rpc("dm.prefs", { channel_id: cid, ...patch });
  }

  /** Delete a DM for me: older messages disappear here, the other person keeps them. */
  async clearDm(cid: number) {
    const r = await this.rpc<{ cleared_before: number }>("dm.clear", { channel_id: cid });
    this.applyCleared(cid, r.cleared_before);
  }

  private applyCleared(cid: number, marker: number) {
    this.patchDm(cid, { cleared_before: marker, archived: false, pinned: false });
    this.logs.delete(cid);
    this.readStates.value = { ...this.readStates.value, [cid]: Math.max(this.readStates.value[cid] ?? 0, marker) };
  }

  async setReadReceipts(on: boolean) {
    await this.rpc("user.read_receipts", { enabled: on });
    if (this.me.value) this.me.value = { ...this.me.value, read_receipts: on };
  }

  isUnread(cid: number): boolean {
    const last = this.lastMessageId(cid);
    return !!last && (this.readStates.value[cid] ?? 0) < last;
  }

  voiceMembers(cid: number): VoiceMember[] {
    return [...this.voice.value.values()].filter((v) => v.channel_id === cid).sort((a, b) => a.joined_at - b.joined_at);
  }

  avatarPath(uid: number): string | null {
    const m = this.members.value.get(uid);
    return m?.avatar ? `/api/v1/avatars/${uid}?v=${m.avatar}` : null;
  }

  // ------------------------------------------------------------- messages

  log(cid: number): ChannelLog {
    let l = this.logs.get(cid);
    if (!l) {
      l = { messages: signal([]), hasMore: signal(true), loading: signal(false), loaded: false, lastUsed: Date.now() };
      this.logs.set(cid, l);
      if (this.logs.size > MAX_CACHED_CHANNELS) {
        const oldest = [...this.logs.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest && oldest[0] !== cid) this.logs.delete(oldest[0]);
      }
    }
    l.lastUsed = Date.now();
    return l;
  }

  async loadInitial(cid: number) {
    const l = this.log(cid);
    if (l.loaded || l.loading.value || !this.conn.ready) return;
    l.loading.value = true;
    try {
      const r = await this.rpc<{ messages: Message[]; has_more: boolean }>("message.history", { channel_id: cid, limit: 50 });
      r.messages = await this.open(r.messages);
      batch(() => {
        const pending = l.messages.value.filter((m) => m.pending || m.failed);
        l.messages.value = [...r.messages, ...pending];
        l.hasMore.value = r.has_more;
      });
      l.loaded = true;
    } finally {
      l.loading.value = false;
    }
  }

  async loadOlder(cid: number): Promise<number> {
    const l = this.log(cid);
    if (l.loading.value || !l.hasMore.value) return 0;
    const first = l.messages.value.find((m) => !m.pending);
    if (!first) return 0;
    l.loading.value = true;
    try {
      const r = await this.rpc<{ messages: Message[]; has_more: boolean }>("message.history", { channel_id: cid, before: first.id, limit: 50 });
      r.messages = await this.open(r.messages);
      batch(() => {
        l.messages.value = [...r.messages, ...l.messages.value];
        l.hasMore.value = r.has_more;
      });
      return r.messages.length;
    } finally {
      l.loading.value = false;
    }
  }

  /** Loads the context around a message (used to jump to search results). */
  async loadAround(cid: number, mid: number) {
    const l = this.log(cid);
    if (l.messages.value.some((m) => m.id === mid)) return;
    const before = await this.rpc<{ messages: Message[]; has_more: boolean }>("message.history", { channel_id: cid, before: mid + 1, limit: 40 });
    const after = await this.rpc<{ messages: Message[] }>("message.history", { channel_id: cid, after: mid, limit: 40 });
    before.messages = await this.open(before.messages);
    after.messages = await this.open(after.messages);
    batch(() => {
      l.messages.value = [...before.messages, ...after.messages];
      l.hasMore.value = before.has_more;
      l.loaded = true;
    });
  }

  private trim(l: ChannelLog) {
    const msgs = l.messages.value;
    if (msgs.length > MAX_CACHED_MESSAGES) {
      l.messages.value = msgs.slice(msgs.length - MAX_CACHED_MESSAGES);
      l.hasMore.value = true;
    }
  }

  // ------------------------------------------------------------- end-to-end encryption

  /** Is end-to-end encryption switched on for this DM (on this device)? */
  e2eOn(cid: number): boolean {
    return !!this.dm(cid) && settings.value.e2eDm[`${this.id}:${cid}`] === true;
  }

  setE2e(cid: number, on: boolean) {
    updateSettings({ e2eDm: { ...settings.value.e2eDm, [`${this.id}:${cid}`]: on } });
  }

  /** What goes over the wire for `content` in channel `cid` (ciphertext in an encrypted DM). */
  async seal(cid: number, content: string, force = false): Promise<string> {
    const dm = this.dm(cid);
    if (!dm || !content || !(force || this.e2eOn(cid))) return content;
    return this.e2e.encrypt(dm.user_id, content, this.info.value?.max_message_len ?? 4000);
  }

  /** Decrypts the encrypted messages in `list` (others pass through unchanged). */
  async open(list: Message[]): Promise<Message[]> {
    if (!list.some((m) => isEnvelope(m.content) || (m.reply_preview && isEnvelope(m.reply_preview.content)))) return list;
    const me = this.me.value?.id;
    const out: Message[] = [];
    for (const m of list) {
      const dm = this.dm(m.channel_id);
      const mine = m.author_id === me;
      // The other side of the conversation: for my own messages the DM partner.
      const peer = dm ? (mine ? dm.user_id : m.author_id) : null;
      let next = m;
      if (isEnvelope(m.content)) {
        const r = peer !== null ? await this.e2e.decrypt(m.content, peer, mine) : ({ fail: "key" } as const);
        next = "text" in r ? { ...m, content: r.text, e2e: "ok" } : { ...m, content: "", e2e: "fail" };
        // The other side writes encrypted: answer the same way from now on.
        if (dm && !mine && settings.value.e2eDm[`${this.id}:${m.channel_id}`] === undefined) this.setE2e(m.channel_id, true);
      }
      const rp = m.reply_preview;
      if (rp && isEnvelope(rp.content)) {
        const rMine = rp.author_id === me;
        const rPeer = dm ? (rMine ? dm.user_id : rp.author_id) : null;
        const r = rPeer !== null ? await this.e2e.decrypt(rp.content, rPeer, rMine) : ({ fail: "key" } as const);
        next = { ...next, reply_preview: { ...rp, content: "text" in r ? r.text.slice(0, 160) : "🔒" } };
      }
      out.push(next);
    }
    return out;
  }

  async send(cid: number, content: string, replyTo: number | null, attachments: string[] = []) {
    const nonce = crypto.randomUUID();
    const me = this.me.value!;
    const l = this.log(cid);
    const temp: Message = {
      id: Number.MAX_SAFE_INTEGER - Math.floor(Math.random() * 1e6),
      channel_id: cid,
      author_id: me.id,
      content,
      reply_to: replyTo,
      created_at: Date.now(),
      edited_at: null,
      mentions: [],
      attachments: [],
      reactions: [],
      pinned_at: null,
      nonce,
      pending: true,
      ...(content && this.e2eOn(cid) ? { e2e: "ok" as const } : {}),
    };
    l.messages.value = [...l.messages.value, temp];
    try {
      const wire = await this.seal(cid, content);
      const msg = await this.rpc<Message>("message.send", { channel_id: cid, content: wire, reply_to: replyTo, attachments, nonce });
      this.upsertMessage((await this.open([msg]))[0], nonce);
    } catch (e) {
      l.messages.value = l.messages.value.map((m) => (m.nonce === nonce ? { ...m, pending: false, failed: true } : m));
      throw e;
    }
  }

  discardFailed(cid: number, nonce: string) {
    const l = this.log(cid);
    l.messages.value = l.messages.value.filter((m) => m.nonce !== nonce);
  }

  private upsertMessage(msg: Message, nonce?: string | null) {
    const l = this.logs.get(msg.channel_id);
    if (l) {
      const msgs = l.messages.value;
      const idx = msgs.findIndex((m) => m.id === msg.id || (nonce && m.nonce === nonce));
      if (idx >= 0) {
        const copy = msgs.slice();
        copy[idx] = msg;
        l.messages.value = copy;
      } else if (l.loaded) {
        // Insert keeping order (pending messages stay at the end).
        const firstPending = msgs.findIndex((m) => m.pending || m.failed);
        const copy = msgs.slice();
        copy.splice(firstPending >= 0 ? firstPending : copy.length, 0, msg);
        l.messages.value = copy;
        this.trim(l);
      }
    }
    this.bumpLastMessage(msg.channel_id, msg.id);
  }

  private bumpLastMessage(cid: number, mid: number) {
    if (this.channel(cid)) {
      this.channels.value = this.channels.value.map((c) =>
        c.id === cid && (c.last_message_id ?? 0) < mid ? { ...c, last_message_id: mid } : c,
      );
    } else if (this.dm(cid)) {
      this.dms.value = this.dms.value.map((d) => (d.channel_id === cid && (d.last_message_id ?? 0) < mid ? { ...d, last_message_id: mid } : d));
    }
  }

  /** Moves the read marker back so the channel shows as unread from `messageId` on. */
  async markUnread(cid: number, messageId: number) {
    this.readStates.value = { ...this.readStates.value, [cid]: messageId - 1 };
    await this.rpc("channel.ack", { channel_id: cid, message_id: messageId - 1, unread: true });
  }

  async ack(cid: number) {
    const last = this.lastMessageId(cid);
    if (!last || (this.readStates.value[cid] ?? 0) >= last || !this.conn.ready) return;
    this.readStates.value = { ...this.readStates.value, [cid]: last };
    if (this.mentionCounts.value[cid]) {
      const mc = { ...this.mentionCounts.value };
      delete mc[cid];
      this.mentionCounts.value = mc;
    }
    try {
      await this.rpc("channel.ack", { channel_id: cid, message_id: last });
    } catch {
      /* will be retried with the next message */
    }
  }

  // ------------------------------------------------------------- files

  async upload(cid: number, file: File, onProgress: (p: number) => void): Promise<string> {
    const path = `/api/v1/files?channel_id=${cid}&filename=${encodeURIComponent(file.name)}`;
    const r = await transport.upload(this.target(), path, this.token, file, (done, total) => onProgress(total ? done / total : 0));
    if (r.status !== 200) throw (r.body?.error as ApiErr) ?? { code: "INTERNAL", msg: `HTTP ${r.status}` };
    return r.body.id as string;
  }

  // ------------------------------------------------------------- events

  private applyReady(r: Ready, reconnect: boolean) {
    batch(() => {
      this.me.value = r.me;
      this.info.value = r.server;
      this.applyGuild(r.guild);
      this.members.value = new Map(r.members.map((m) => [m.id, m]));
      this.dms.value = r.dms;
      this.readStates.value = Object.fromEntries(Object.entries(r.read_states).map(([k, v]) => [Number(k), v]));
      this.mentionCounts.value = Object.fromEntries(Object.entries(r.mention_counts).map(([k, v]) => [Number(k), v]));
      this.relationships.value = new Map(r.relationships.map((x) => [x.user_id, x.kind]));
      this.voice.value = new Map(r.voice.map((v) => [v.user_id, v]));
      this.ice = r.ice;
      if (this.saved.value.name !== r.server.name || this.saved.value.username !== r.me.username) {
        this.saved.value = { ...this.saved.value, name: r.server.name, username: r.me.username };
      }
    });
    this.e2e.onReady();
    if (reconnect) {
      // Messages may have been missed while offline: reload open histories.
      for (const [cid, l] of this.logs) {
        if (l.loaded) {
          l.loaded = false;
          void this.loadInitial(cid);
        }
      }
    }
    this.listener(this, "ready", { reconnect });
  }

  private applyGuild(g: Ready["guild"]) {
    this.roles.value = g.roles;
    this.categories.value = g.categories;
    this.channels.value = g.channels;
    this.perms.value = g.perms;
    this.isOwner.value = g.is_owner;
  }

  private setTyping(cid: number, uid: number, until: number | null) {
    const t = { ...this.typing.value };
    const c = { ...(t[cid] ?? {}) };
    if (until) c[uid] = until;
    else delete c[uid];
    t[cid] = c;
    this.typing.value = t;
    if (!this.typingTimer) {
      this.typingTimer = setInterval(() => {
        const now = Date.now();
        let any = false;
        const next: Record<number, Record<number, number>> = {};
        for (const [k, users] of Object.entries(this.typing.value)) {
          const kept = Object.fromEntries(Object.entries(users).filter(([, exp]) => exp > now));
          if (Object.keys(kept).length) {
            next[Number(k)] = kept as Record<number, number>;
            any = true;
          }
        }
        this.typing.value = next;
        if (!any && this.typingTimer) {
          clearInterval(this.typingTimer);
          this.typingTimer = null;
        }
      }, 1000);
    }
  }

  private onEvent(ev: string, d: any) {
    // Encrypted messages are decrypted first; a queue keeps their order.
    if ((ev === "message.created" || ev === "message.updated") && this.needsOpen(ev === "message.created" ? d.message : d)) {
      this.openChain = this.openChain
        .then(async () => {
          const [m] = await this.open([ev === "message.created" ? d.message : d]);
          this.applyEvent(ev, ev === "message.created" ? { ...d, message: m } : m);
        })
        .catch(() => {});
      return;
    }
    this.applyEvent(ev, d);
  }

  private needsOpen(m: Message | undefined): boolean {
    return !!m && (isEnvelope(m.content) || (!!m.reply_preview && isEnvelope(m.reply_preview.content)));
  }

  private applyEvent(ev: string, d: any) {
    switch (ev) {
      case "e2e.key":
        this.e2e.onKeyEvent(d.user_id);
        break;
      case "message.created": {
        const m = d.message as Message;
        this.upsertMessage(m, d.nonce);
        this.setTyping(m.channel_id, m.author_id, null);
        const me = this.me.value?.id;
        if (m.author_id === me) {
          this.readStates.value = { ...this.readStates.value, [m.channel_id]: m.id };
        } else if (me && m.mentions.includes(me)) {
          this.mentionCounts.value = { ...this.mentionCounts.value, [m.channel_id]: (this.mentionCounts.value[m.channel_id] ?? 0) + 1 };
        }
        break;
      }
      case "message.updated":
        this.upsertMessage(d as Message);
        break;
      case "message.deleted": {
        const l = this.logs.get(d.channel_id);
        if (l) l.messages.value = l.messages.value.filter((m) => m.id !== d.id);
        break;
      }
      case "reaction.update": {
        const l = this.logs.get(d.channel_id);
        if (l) {
          l.messages.value = l.messages.value.map((m) => {
            if (m.id !== d.message_id) return m;
            let rs = m.reactions.map((r) => ({ ...r, users: r.users.slice() }));
            let r = rs.find((x) => x.emoji === d.emoji);
            if (d.added) {
              if (!r) rs.push((r = { emoji: d.emoji, users: [] }));
              if (!r.users.includes(d.user_id)) r.users.push(d.user_id);
            } else if (r) {
              r.users = r.users.filter((u) => u !== d.user_id);
              if (!r.users.length) rs = rs.filter((x) => x !== r);
            }
            return { ...m, reactions: rs };
          });
        }
        break;
      }
      case "typing":
        this.setTyping(d.channel_id, d.user_id, Date.now() + 7000);
        break;
      case "read_state.update":
        this.readStates.value = { ...this.readStates.value, [d.channel_id]: d.message_id };
        break;
      case "guild.sync":
        this.applyGuild(d);
        break;
      case "member.updated": {
        const map = new Map(this.members.value);
        map.set(d.id, d);
        this.members.value = map;
        if (d.id === this.me.value?.id) this.me.value = { ...this.me.value!, ...d };
        break;
      }
      case "member.removed": {
        const map = new Map(this.members.value);
        map.delete(d.user_id);
        this.members.value = map;
        break;
      }
      case "presence.update": {
        const m = this.members.value.get(d.user_id);
        if (m) {
          const map = new Map(this.members.value);
          map.set(d.user_id, { ...m, presence: d.presence });
          this.members.value = map;
        }
        break;
      }
      case "self.presence":
        if (this.me.value) this.me.value = { ...this.me.value, presence: d.presence };
        break;
      case "server.updated":
        this.info.value = d;
        break;
      case "dm.created":
        if (!this.dm(d.channel_id)) this.dms.value = [...this.dms.value, d];
        break;
      case "dm.prefs": {
        const patch: Partial<Dm> = {};
        if (typeof d.archived === "boolean") patch.archived = d.archived;
        if (typeof d.pinned === "boolean") patch.pinned = d.pinned;
        this.patchDm(d.channel_id, patch);
        break;
      }
      case "dm.cleared":
        if ((this.dm(d.channel_id)?.cleared_before ?? 0) < d.cleared_before) this.applyCleared(d.channel_id, d.cleared_before);
        break;
      case "dm.read": {
        const cur = this.dm(d.channel_id);
        if (cur && (cur.peer_read ?? 0) < d.message_id) this.patchDm(d.channel_id, { peer_read: d.message_id });
        break;
      }
      case "user.read_receipts":
        if (this.me.value) this.me.value = { ...this.me.value, read_receipts: !!d.enabled };
        break;
      case "relationship.update": {
        const map = new Map(this.relationships.value);
        if (d.kind) map.set(d.user_id, d.kind);
        else map.delete(d.user_id);
        this.relationships.value = map;
        break;
      }
      case "voice.state": {
        const map = new Map(this.voice.value);
        if (d.left) {
          if (map.get(d.user_id)?.channel_id === d.channel_id) map.delete(d.user_id);
        } else map.set(d.user_id, d);
        this.voice.value = map;
        break;
      }
    }
    this.listener(this, ev, d);
  }
}

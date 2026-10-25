// Member list, profile card and the user context menu (with moderation
// actions where permitted). The same menu opens everywhere a person appears:
// member list, chat, voice channel.

import { useState } from "preact/hooks";
import { closeModal, openDm, openModal, settings, showMenu, startDm, toast, updateSettings, type MenuItem } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Member } from "../types";
import { P } from "../types";
import { errorText, fmtFull, presenceText, t } from "../i18n";
import { Avatar, Icon, Modal, bannerCss, confirmDialog, copyText, promptDialog } from "./components";
import { joinVoice, voice } from "../rtc/voice";
import { insertText } from "./Chat";

function relationAction(server: ServerStore, m: Member) {
  const rel = server.relationships.value.get(m.id);
  const run = (op: string) => server.rpc(op, { user_id: m.id }).catch((e) => toast(t("common.actionFailed"), errorText(e), "error"));
  return { rel, run };
}

/** Highest role position; the owner ranks above everyone (mirrors the server). */
function rank(server: ServerStore, uid: number) {
  const m = server.member(uid);
  if (!m) return 0;
  if (m.is_owner) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, ...server.roles.value.filter((r) => m.roles.includes(r.id)).map((r) => r.position));
}

/** I may moderate this person: ranked higher and they are not the owner. */
export function canModerate(server: ServerStore, target: number) {
  const me = server.me.value?.id;
  const m = server.member(target);
  if (me === undefined || target === me || !m || m.is_owner) return false;
  return server.isOwner.value || rank(server, me) > rank(server, target);
}

export function timeoutActive(m: Member | undefined) {
  return !!m?.timeout_until && m.timeout_until > Date.now();
}

const TIMEOUTS: [number, string][] = [
  [1, "mod.t1m"],
  [5, "mod.t5m"],
  [10, "mod.t10m"],
  [60, "mod.t1h"],
  [24 * 60, "mod.t1d"],
  [7 * 24 * 60, "mod.t1w"],
];

const fail = (e: unknown) => toast(t("common.actionFailed"), errorText(e), "error");

export async function timeoutMember(server: ServerStore, m: Member, minutes: number) {
  try {
    await server.rpc("member.timeout", { user_id: m.id, minutes });
    toast(minutes ? t("mod.timeoutSet", { name: m.display_name || m.username }) : t("mod.timeoutLifted", { name: m.display_name || m.username }), undefined, "ok");
  } catch (e) {
    fail(e);
  }
}

export async function kickMember(server: ServerStore, m: Member) {
  const name = m.display_name || m.username;
  const reason = await promptDialog({ title: t("mod.kickTitle", { name }), label: t("mod.reason"), body: t("mod.kickBody"), confirm: t("mod.kick"), danger: true });
  if (reason === null) return;
  try {
    await server.rpc("member.kick", { user_id: m.id, reason });
    toast(t("mod.kicked", { name }), undefined, "ok");
  } catch (e) {
    fail(e);
  }
}

export async function banMember(server: ServerStore, m: Member) {
  const name = m.display_name || m.username;
  if (!(await confirmDialog({ title: t("member.banTitle", { name }), body: t("member.banBody"), confirm: t("member.ban"), danger: true }))) return;
  try {
    await server.rpc("member.ban", { user_id: m.id });
    toast(t("member.banned"), m.username, "ok");
  } catch (e) {
    toast(t("member.banFailed"), errorText(e), "error");
  }
}

export async function editNote(server: ServerStore, m: Member) {
  const key = `${server.id}:${m.id}`;
  const cur = settings.value.notes[key] ?? "";
  const next = await promptDialog({ title: t("member.noteTitle", { name: m.display_name || m.username }), label: t("member.note"), body: t("member.noteHint"), confirm: t("common.save"), value: cur });
  if (next === null) return;
  const notes = { ...settings.value.notes };
  if (next.trim()) notes[key] = next.trim().slice(0, 500);
  else delete notes[key];
  updateSettings({ notes });
}

/** Calls someone: opens the DM and starts (or joins) the call there. */
export async function callMember(server: ServerStore, uid: number) {
  try {
    const r = await server.rpc<{ channel_id: number }>("dm.open", { user_id: uid });
    openDm(server, r.channel_id);
    await joinVoice(server, r.channel_id);
  } catch (e) {
    toast(t("common.error"), errorText(e), "error");
  }
}

/** Everything that can be done with a person, grouped so the menu stays short. */
export function memberMenuItems(server: ServerStore, m: Member): MenuItem[] {
  const me = server.me.value?.id;
  const self = m.id === me;
  const { rel, run } = relationAction(server, m);
  const v = voice.value;
  const key = `${server.id}:${m.id}`;
  const vm = server.voice.value.get(m.id);
  const inMyCall = !!v && v.server === server && vm?.channel_id === v.channelId && !self;
  const mod = canModerate(server, m.id);
  const items: MenuItem[] = [
    { label: t("member.profile"), onClick: () => openModal(<ProfileCard server={server} member={m} />) },
  ];
  if (!self) {
    items.push(
      { label: t("member.sendDm"), onClick: () => void startDm(server, m.id).catch(fail) },
      { label: t("member.call"), onClick: () => void callMember(server, m.id) },
    );
  }
  items.push(
    { label: t("member.mention"), onClick: () => (insertText.value = `@${m.username} `) },
    { label: settings.value.notes[key] ? t("member.editNote") : t("member.addNote"), onClick: () => void editNote(server, m) },
  );
  if (inMyCall) {
    const vol = settings.value.userVolume[key] ?? 1;
    const muted = !!settings.value.localMute[key];
    items.push(
      { separator: true, label: "" },
      {
        label: `${t("member.volume")} · ${Math.round(vol * 100)} %`,
        sub: [2, 1.5, 1, 0.75, 0.5, 0.25].map((x) => ({
          label: `${Math.round(x * 100)} %`,
          checked: vol === x,
          onClick: () => {
            updateSettings({ userVolume: { ...settings.value.userVolume, [key]: x } });
            v.refreshOutputs();
          },
        })),
      },
      {
        label: t("member.localMute"),
        checked: muted,
        onClick: () => {
          updateSettings({ localMute: { ...settings.value.localMute, [key]: !muted } });
          v.refreshOutputs();
        },
      },
    );
  }
  if (!self) {
    items.push(
      { separator: true, label: "" },
      rel === "friend"
        ? { label: t("member.removeFriend"), onClick: () => void run("relationship.remove") }
        : rel === "incoming"
          ? { label: t("member.acceptFriend"), onClick: () => void run("relationship.request") }
          : rel === "outgoing"
            ? { label: t("member.withdraw"), onClick: () => void run("relationship.remove") }
            : { label: t("member.addFriend"), onClick: () => void run("relationship.request") },
      rel === "blocked"
        ? { label: t("member.unblock"), onClick: () => void run("relationship.unblock") }
        : { label: t("member.block"), danger: true, onClick: () => void run("relationship.block") },
    );
  }
  // Voice moderation (server mute/deafen, move, disconnect).
  if (vm && (mod || (self && server.can(P.MOVE_MEMBERS)))) {
    const voiceItems: MenuItem[] = [];
    if (server.can(P.MUTE_MEMBERS) && mod) {
      voiceItems.push(
        { label: t("mod.serverMute"), checked: !!vm.server_muted, onClick: () => void server.rpc("voice.moderate", { user_id: m.id, mute: !vm.server_muted }).catch(fail) },
        { label: t("mod.serverDeafen"), checked: !!vm.server_deafened, onClick: () => void server.rpc("voice.moderate", { user_id: m.id, deafen: !vm.server_deafened }).catch(fail) },
      );
    }
    if (server.can(P.MOVE_MEMBERS)) {
      const targets = server.channels.value.filter((c) => c.kind === "voice" && c.id !== vm.channel_id);
      if (targets.length) {
        voiceItems.push({
          label: t("mod.moveTo"),
          sub: targets.map((c) => ({ label: c.name, onClick: () => void server.rpc("voice.move", { user_id: m.id, channel_id: c.id }).catch(fail) })),
        });
      }
      if (!self) voiceItems.push({ label: t("mod.disconnect"), danger: true, onClick: () => void server.rpc("voice.move", { user_id: m.id, channel_id: null }).catch(fail) });
    }
    if (voiceItems.length) items.push({ separator: true, label: "" }, { label: t("mod.voice"), sub: voiceItems });
  }
  // Server moderation.
  if (mod) {
    const modItems: MenuItem[] = [];
    if (server.can(P.MODERATE_MEMBERS)) {
      modItems.push({
        label: timeoutActive(m) ? t("mod.timeoutRunning") : t("mod.timeout"),
        sub: [
          ...TIMEOUTS.map(([min, k]) => ({ label: t(k as "mod.t1m"), onClick: () => void timeoutMember(server, m, min) })),
          ...(timeoutActive(m) ? [{ separator: true, label: "" }, { label: t("mod.timeoutLift"), onClick: () => void timeoutMember(server, m, 0) }] : []),
        ],
      });
    }
    if (server.can(P.KICK_MEMBERS)) modItems.push({ label: t("mod.kick"), danger: true, onClick: () => void kickMember(server, m) });
    if (server.can(P.BAN_MEMBERS)) modItems.push({ label: t("member.ban"), danger: true, onClick: () => void banMember(server, m) });
    if (server.can(P.MANAGE_ROLES)) modItems.push({ label: t("mod.roles"), onClick: () => openModal(<ProfileCard server={server} member={m} />) });
    if (modItems.length) items.push({ label: t("mod.moderation"), sub: modItems });
  }
  items.push(
    { separator: true, label: "" },
    { label: t("member.copyName"), onClick: () => copyText(m.username) },
    { label: t("member.copyId"), onClick: () => copyText(String(m.id)) },
  );
  return items;
}

export function memberMenu(e: MouseEvent, server: ServerStore, m: Member) {
  showMenu(e, memberMenuItems(server, m));
}

export function MemberList({ server }: { server: ServerStore; channelId: number }) {
  const all = [...server.members.value.values()];
  const byName = (a: Member, b: Member) => (a.display_name || a.username).localeCompare(b.display_name || b.username);
  const online = all.filter((m) => m.presence !== "offline").sort(byName);
  const offline = all.filter((m) => m.presence === "offline").sort(byName);
  const v = voice.value;
  const speaking = v && v.server === server ? v.speaking.value : null;
  const row = (m: Member) => (
    <div key={m.id} class={`member${m.presence === "offline" ? " offline" : ""}`} onClick={() => openModal(<ProfileCard server={server} member={m} />)} onContextMenu={(e) => memberMenu(e, server, m)}>
      <Avatar server={server} userId={m.id} name={m.display_name || m.username} size={30} presence={m.presence} speaking={speaking?.has(m.id)} />
      <div class="names grow">
        <div class="ellipsis" style={{ color: server.roleColor(m.id), fontWeight: 600 }}>
          {m.display_name || m.username} {m.is_owner && <span title={t("member.owner")}>👑</span>}
          {timeoutActive(m) && <span class="timeout-mark" title={t("mod.timeoutUntil", { time: fmtFull(m.timeout_until!) })}><Icon.Clock size={12} /></span>}
        </div>
        {m.status_text && <div class="status-text ellipsis">{m.status_text}</div>}
      </div>
    </div>
  );
  return (
    <aside class="members" aria-label={t("member.members")}>
      <h4>{t("member.online")} – {online.length}</h4>
      {online.map(row)}
      {offline.length > 0 && <h4>{t("member.offline")} – {offline.length}</h4>}
      {offline.map(row)}
    </aside>
  );
}

export function ProfileCard({ server, member }: { server: ServerStore; member: Member }) {
  const m = server.members.value.get(member.id) ?? member;
  const me = server.me.value?.id;
  const { rel, run } = relationAction(server, m);
  const roles = server.roles.value;
  const canRoles = server.can(P.MANAGE_ROLES) && (server.isOwner.value || m.id !== me);
  const mod = canModerate(server, m.id);
  const [selected, setSelected] = useState<number[]>(m.roles);
  const [busy, setBusy] = useState(false);
  const name = m.display_name || m.username;
  const note = settings.value.notes[`${server.id}:${m.id}`] ?? "";

  const saveRoles = async () => {
    setBusy(true);
    try {
      await server.rpc("member.set_roles", { user_id: m.id, role_ids: selected });
      toast(t("member.rolesSaved"), undefined, "ok");
    } catch (e) {
      toast(t("member.rolesFailed"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      footer={
        m.id !== me ? (
          <>
            <button class="btn ghost" onClick={() => void run(rel === "blocked" ? "relationship.unblock" : "relationship.block")}>
              {rel === "blocked" ? t("member.unblock") : t("member.block")}
            </button>
            <button class="btn outline" onClick={() => void run(rel === "friend" || rel === "outgoing" ? "relationship.remove" : "relationship.request")}>
              {rel === "friend" ? t("member.removeFriend") : rel === "incoming" ? t("member.acceptFriend") : rel === "outgoing" ? t("member.withdraw") : t("member.addFriend")}
            </button>
            <button
              class="btn outline"
              title={t("member.call")}
              onClick={() => {
                closeModal();
                void callMember(server, m.id);
              }}
            >
              <Icon.Speaker size={16} />
            </button>
            <button
              class="btn primary"
              onClick={() => {
                closeModal();
                void startDm(server, m.id).catch((e) => toast(t("common.error"), errorText(e), "error"));
              }}
            >
              {t("member.message")}
            </button>
          </>
        ) : (
          <button class="btn" onClick={closeModal}>{t("common.close")}</button>
        )
      }
    >
      <div class="profile-head">
        <div class="profile-banner big" style={{ background: bannerCss(m.banner, server.roleColor(m.id)) }} />
        <div class="row profile-id" style={{ gap: "14px" }}>
          <div class="profile-avatar"><Avatar server={server} userId={m.id} name={name} size={84} presence={m.presence} /></div>
          <div class="grow" style={{ minWidth: "0px" }}>
            <h2 style={{ margin: "0px" }} class="ellipsis">{name}</h2>
            <div class="muted selectable">@{m.username}</div>
            <div class="faint small">{presenceText(m.presence)}{m.is_owner ? ` · ${t("member.owner")}` : ""}</div>
          </div>
        </div>
      </div>
      {m.bio && (
        <div>
          <div class="label" style={{ marginBottom: "4px" }}>{t("profile.bio")}</div>
          <div class="small selectable profile-bio">{m.bio}</div>
        </div>
      )}
      {timeoutActive(m) && (
        <div class="notice warn small row">
          <Icon.Clock size={16} />
          <span class="grow">{t("mod.timeoutUntil", { time: fmtFull(m.timeout_until!) })}</span>
          {mod && server.can(P.MODERATE_MEMBERS) && <button class="btn sm" onClick={() => void timeoutMember(server, m, 0)}>{t("mod.timeoutLift")}</button>}
        </div>
      )}
      {m.status_text && <div class="card small selectable">{m.status_text}</div>}
      <div>
        <div class="label" style={{ marginBottom: "6px" }}>{t("member.roles")}</div>
        {canRoles ? (
          <div class="col" style={{ gap: "6px" }}>
            {roles.map((r) => (
              <label class="checkbox small" key={r.id}>
                <input type="checkbox" checked={selected.includes(r.id)} onChange={(e) => setSelected((e.target as HTMLInputElement).checked ? [...selected, r.id] : selected.filter((x) => x !== r.id))} />
                <span style={{ color: r.color || undefined }}>{r.name}</span>
              </label>
            ))}
            <div class="row">
              <button class="btn sm primary" disabled={busy} onClick={saveRoles}>{t("member.saveRoles")}</button>
            </div>
          </div>
        ) : (
          <div class="row wrap" style={{ gap: "6px" }}>
            {roles.filter((r) => m.roles.includes(r.id)).map((r) => (
              <span class="badge" key={r.id} style={{ color: r.color || undefined }}>{r.name}</span>
            ))}
            {!m.roles.length && <span class="faint small">{t("common.none")}</span>}
          </div>
        )}
      </div>
      {m.id !== me && (
        <div>
          <div class="row" style={{ marginBottom: "6px" }}>
            <div class="label grow" style={{ margin: "0px" }}>{t("member.note")}</div>
            <button class="btn sm ghost" onClick={() => void editNote(server, m)}><Icon.Note size={14} /> {note ? t("common.edit") : t("member.addNote")}</button>
          </div>
          {note ? <div class="card small selectable" style={{ whiteSpace: "pre-wrap" }}>{note}</div> : <div class="faint xs">{t("member.noteHint")}</div>}
        </div>
      )}
      {mod && (server.can(P.MODERATE_MEMBERS) || server.can(P.KICK_MEMBERS) || server.can(P.BAN_MEMBERS)) && (
        <div>
          <div class="label" style={{ marginBottom: "6px" }}>{t("mod.moderation")}</div>
          <div class="row wrap" style={{ gap: "6px" }}>
            {server.can(P.MODERATE_MEMBERS) && (
              <button class="btn sm" onClick={(e) => showMenu(e, TIMEOUTS.map(([min, k]) => ({ label: t(k as "mod.t1m"), onClick: () => void timeoutMember(server, m, min) })))}>
                <Icon.Clock size={14} /> {t("mod.timeout")}
              </button>
            )}
            {server.can(P.KICK_MEMBERS) && <button class="btn sm danger" onClick={() => void kickMember(server, m)}><Icon.UserMinus size={14} /> {t("mod.kick")}</button>}
            {server.can(P.BAN_MEMBERS) && <button class="btn sm danger" onClick={() => void banMember(server, m)}><Icon.Hammer size={14} /> {t("member.ban")}</button>}
          </div>
        </div>
      )}
    </Modal>
  );
}

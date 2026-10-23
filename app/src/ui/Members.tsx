// Member list and profile card (with moderation actions where permitted).

import { useState } from "preact/hooks";
import { closeModal, openModal, settings, showMenu, startDm, toast, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Member } from "../types";
import { P } from "../types";
import { errorText, presenceText, t } from "../i18n";
import { Avatar, Modal, confirmDialog, copyText } from "./components";
import { voice } from "../rtc/voice";

function relationAction(server: ServerStore, m: Member) {
  const rel = server.relationships.value.get(m.id);
  const run = (op: string) => server.rpc(op, { user_id: m.id }).catch((e) => toast(t("common.actionFailed"), errorText(e), "error"));
  return { rel, run };
}

export function memberMenu(e: MouseEvent, server: ServerStore, m: Member) {
  const me = server.me.value?.id;
  const { rel, run } = relationAction(server, m);
  const v = voice.value;
  const volKey = `${server.id}:${m.id}`;
  const items = [
    { label: t("member.profile"), onClick: () => openModal(<ProfileCard server={server} member={m} />) },
    ...(m.id !== me
      ? [
          { label: t("member.sendDm"), onClick: () => void startDm(server, m.id).catch((er) => toast(t("common.error"), errorText(er), "error")) },
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
        ]
      : []),
    ...(v && v.server === server && m.id !== me
      ? [
          { separator: true, label: "" },
          ...[1, 0.75, 0.5, 0.25, 0].map((x) => ({
            label: `${t("member.volume")} ${Math.round(x * 100)} %${(settings.value.userVolume[volKey] ?? 1) === x ? " ✓" : ""}`,
            onClick: () => {
              updateSettings({ userVolume: { ...settings.value.userVolume, [volKey]: x } });
              v.refreshOutputs();
            },
          })),
        ]
      : []),
    { separator: true, label: "" },
    { label: t("member.copyName"), onClick: () => copyText(m.username) },
  ];
  showMenu(e, items);
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
  const canBan = server.can(P.BAN_MEMBERS) && m.id !== me && !m.is_owner;
  const [selected, setSelected] = useState<number[]>(m.roles);
  const [busy, setBusy] = useState(false);
  const name = m.display_name || m.username;

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
  const ban = async () => {
    if (!(await confirmDialog({ title: t("member.banTitle", { name }), body: t("member.banBody"), confirm: t("member.ban"), danger: true }))) return;
    try {
      await server.rpc("member.ban", { user_id: m.id });
      toast(t("member.banned"), m.username, "ok");
    } catch (e) {
      toast(t("member.banFailed"), errorText(e), "error");
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
      <div class="row" style={{ gap: "14px" }}>
        <Avatar server={server} userId={m.id} name={name} size={72} presence={m.presence} />
        <div class="grow" style={{ minWidth: "0px" }}>
          <h2 style={{ margin: "0px" }} class="ellipsis">{name}</h2>
          <div class="muted selectable">@{m.username}</div>
          <div class="faint small">{presenceText(m.presence)}{m.is_owner ? ` · ${t("member.owner")}` : ""}</div>
        </div>
      </div>
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
              {canBan && <button class="btn sm danger" onClick={ban}>{t("member.ban")}</button>}
            </div>
          </div>
        ) : (
          <div class="row wrap" style={{ gap: "6px" }}>
            {roles.filter((r) => m.roles.includes(r.id)).map((r) => (
              <span class="badge" key={r.id} style={{ color: r.color || undefined }}>{r.name}</span>
            ))}
            {!m.roles.length && <span class="faint small">{t("common.none")}</span>}
            {canBan && <button class="btn sm danger" onClick={ban}>{t("member.ban")}</button>}
          </div>
        )}
      </div>
    </Modal>
  );
}

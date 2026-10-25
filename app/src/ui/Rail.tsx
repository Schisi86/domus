// Left server rail: home, servers, add and the hosting center.

import { activeServer, activeServerId, closeModal, isMuted, openModal, removeServer, selectServer, servers, settings, showMenu, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import { transport } from "../net/transport";
import { t } from "../i18n";
import { hosts, reachProblem, runningHosts } from "../state/hosting";
import { isTauri } from "../platform";
import { Modal, confirmDialog, initials, useBlobUrl, Icon } from "./components";
import { InboxPanel } from "./Chat";
import { AddServerDialog } from "./dialogs/AddServer";
import { HostDialog } from "./dialogs/Host";
import { ServerSettingsDialog } from "./dialogs/ServerSettings";
import { InviteDialog } from "./dialogs/Invite";

function serverBadge(s: ServerStore) {
  const mentions = Object.values(s.mentionCounts.value).reduce((a, b) => a + b, 0);
  const unread = s.channels.value.some((c) => c.kind === "text" && s.isUnread(c.id) && !isMuted(s.id, c.id)) && !isMuted(s.id);
  return { mentions, unread };
}

export function homeBadge() {
  let n = 0;
  for (const s of servers.value) for (const d of s.dms.value) if (s.isUnread(d.channel_id)) n++;
  return n;
}

function ServerButton({ s }: { s: ServerStore }) {
  const info = s.info.value;
  const icon = useBlobUrl(s, info?.icon ? `/api/v1/icon?v=${info.icon}` : null);
  const { mentions, unread } = serverBadge(s);
  const state = s.conn.state.value;
  const active = activeServerId.value === s.id;
  const name = s.displayName();
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      { label: t("rail.markRead"), onClick: () => s.channels.value.forEach((c) => void s.ack(c.id)) },
      {
        label: isMuted(s.id) ? t("rail.unmute") : t("rail.mute"),
        onClick: () => updateSettings({ muted: { ...settings.value.muted, [s.id]: !isMuted(s.id) } }),
      },
      { separator: true, label: "" },
      { label: t("rail.invite"), onClick: () => openModal(<InviteDialog server={s} />) },
      { label: t("rail.serverSettings"), onClick: () => openModal(<ServerSettingsDialog server={s} />) },
      { label: t("rail.reconnect"), onClick: () => s.conn.retryNow() },
      { separator: true, label: "" },
      {
        label: t("rail.remove"),
        danger: true,
        onClick: async () => {
          if (await confirmDialog({ title: t("rail.removeTitle"), body: t("rail.removeBody", { name }), confirm: t("common.remove"), danger: true })) {
            // End the session on the server, then forget it locally.
            void transport.http(s.target(), "POST", "/api/v1/auth/logout", s.token).catch(() => {});
            removeServer(s.id);
          }
        },
      },
    ]);
  return (
    <div class={`rail-item${active ? " active" : ""}${unread ? " unread" : ""}`}>
      <span class="rail-pill" />
      <button class="rail-btn" title={name} aria-label={name} onClick={() => selectServer(s.id)} onContextMenu={menu}>
        {icon ? <img src={icon} alt="" /> : initials(name)}
      </button>
      {mentions > 0 && <span class="rail-badge">{mentions > 99 ? "99+" : mentions}</span>}
      {state !== "ready" && (
        <span
          class={`rail-status${state === "auth_failed" || state.startsWith("cert") ? " offline" : ""}`}
          title={state === "reconnecting" || state === "connecting" ? t("conn.connecting") : t("conn.disconnected")}
        />
      )}
    </div>
  );
}

/** Prominent entry to the hosting center; shows how many hosted servers run. */
function HostButton() {
  const n = runningHosts.value;
  const total = hosts.value.length;
  const warn = reachProblem.value;
  const tip = warn ? t("rc.notReachable") : n > 0 ? t("hc.runningTip", { n }) : t("hc.title");
  return (
    <div class={`rail-item${n > 0 ? " hosting" : ""}`}>
      <button class="rail-btn host" title={tip} aria-label={tip} onClick={() => openModal(<HostDialog />)}>
        <Icon.ServerIcon size={19} class="" />
      </button>
      {isTauri && total > 0 && <span class={`rail-host-badge${warn ? " warn" : n > 0 ? " on" : ""}`}>{warn ? "!" : n}</span>}
    </div>
  );
}

/** Inbox (mentions, saved for later) – a dialog so it never crowds the chat. */
function InboxButton() {
  const server = activeServer.value ?? servers.value[0] ?? null;
  const due = settings.value.saved.some((x) => x.remindAt);
  if (!server) return null;
  return (
    <div class="rail-item">
      <button
        class="rail-btn inbox-btn"
        title={t("inbox.title")}
        aria-label={t("inbox.title")}
        onClick={() =>
          openModal(
            <Modal title={t("inbox.title")} sub={server.displayName()} class="inbox-modal">
              <InboxPanel server={server} onClose={closeModal} />
            </Modal>,
          )
        }
      >
        <Icon.Inbox size={20} class="" />
      </button>
      {due && <span class="rail-dot" />}
    </div>
  );
}

export function Rail() {
  const home = activeServerId.value === null;
  const hb = homeBadge();
  return (
    <nav class="rail" aria-label={t("rail.servers")}>
      <div class={`rail-item${home ? " active" : ""}`}>
        <span class="rail-pill" />
        <button class="rail-btn home" title={t("rail.home")} aria-label={t("rail.home")} onClick={() => selectServer(null)}>
          <Icon.Mail size={22} class="" />
        </button>
        {hb > 0 && <span class="rail-badge">{hb}</span>}
      </div>
      <InboxButton />
      <div class="rail-sep" />
      {servers.value.map((s) => (
        <ServerButton key={s.id} s={s} />
      ))}
      <div class="rail-item">
        <button class="rail-btn add" title={t("rail.add")} aria-label={t("rail.add")} onClick={() => openModal(<AddServerDialog />)}>
          <Icon.Plus size={20} class="" />
        </button>
      </div>
      <div class="spacer" />
      <HostButton />
    </nav>
  );
}

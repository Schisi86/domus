// Left server rail: home, servers, add/host, donation and language switcher.

import { activeServerId, isMuted, openModal, removeServer, selectServer, servers, settings, showMenu, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import { transport } from "../net/transport";
import { t } from "../i18n";
import { confirmDialog, initials, useBlobUrl, Icon } from "./components";
import { AddServerDialog } from "./dialogs/AddServer";
import { HostDialog } from "./dialogs/Host";
import { ServerSettingsDialog } from "./dialogs/ServerSettings";
import { InviteDialog } from "./dialogs/Invite";
import { AboutDialog } from "./dialogs/About";
import { LangPicker } from "./LangPicker";

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

export function Rail() {
  const home = activeServerId.value === null;
  const hb = homeBadge();
  return (
    <nav class="rail" aria-label={t("rail.servers")}>
      <div class={`rail-item${home ? " active" : ""}`}>
        <span class="rail-pill" />
        <button class="rail-btn" title={t("rail.home")} aria-label={t("rail.home")} onClick={() => selectServer(null)} style={{ padding: "0" }}>
          <img src="/icon.png" alt="" style={{ width: "100%", height: "100%" }} draggable={false} />
        </button>
        {hb > 0 && <span class="rail-badge">{hb}</span>}
      </div>
      <div class="rail-sep" />
      {servers.value.map((s) => (
        <ServerButton key={s.id} s={s} />
      ))}
      <div class="rail-item">
        <button class="rail-btn add" title={t("rail.add")} aria-label={t("rail.add")} onClick={() => openModal(<AddServerDialog />)}>
          <Icon.Plus size={20} class="" />
        </button>
      </div>
      <div class="rail-item">
        <button class="rail-btn add" title={t("rail.host")} aria-label={t("rail.host")} onClick={() => openModal(<HostDialog />)}>
          <Icon.ServerIcon size={18} class="" />
        </button>
      </div>
      <div class="spacer" />
      <div class="rail-item">
        <button class="rail-btn heart" title={t("about.donate")} aria-label={t("about.donate")} onClick={() => openModal(<AboutDialog />)}>
          <Icon.Heart size={18} class="" />
        </button>
      </div>
      <div class="rail-item">
        <LangPicker />
      </div>
    </nav>
  );
}

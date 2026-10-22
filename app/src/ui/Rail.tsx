// Left server rail: home (direct messages), servers, add / host buttons.

import { activeServerId, isMuted, openModal, removeServer, selectServer, servers, settings, showMenu, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import { transport } from "../net/transport";
import { confirmDialog, initials, useBlobUrl, Icon } from "./components";
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
      { label: "Als gelesen markieren", onClick: () => s.channels.value.forEach((c) => void s.ack(c.id)) },
      {
        label: isMuted(s.id) ? "Benachrichtigungen aktivieren" : "Server stummschalten",
        onClick: () => updateSettings({ muted: { ...settings.value.muted, [s.id]: !isMuted(s.id) } }),
      },
      { separator: true, label: "" },
      { label: "Personen einladen", onClick: () => openModal(<InviteDialog server={s} />) },
      { label: "Servereinstellungen", onClick: () => openModal(<ServerSettingsDialog server={s} />) },
      { label: "Neu verbinden", onClick: () => s.conn.retryNow() },
      { separator: true, label: "" },
      {
        label: "Server aus Liste entfernen",
        danger: true,
        onClick: async () => {
          if (await confirmDialog({ title: "Server entfernen?", body: `„${name}“ wird aus deiner Liste entfernt und du wirst abgemeldet. Dein Konto auf dem Server bleibt bestehen.`, confirm: "Entfernen", danger: true })) {
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
          title={state === "reconnecting" || state === "connecting" ? "Verbindung wird aufgebaut" : "Nicht verbunden"}
        />
      )}
    </div>
  );
}

export function Rail() {
  const home = activeServerId.value === null;
  const hb = homeBadge();
  return (
    <nav class="rail" aria-label="Server">
      <div class={`rail-item${home ? " active" : ""}`}>
        <span class="rail-pill" />
        <button class="rail-btn home" title="Direktnachrichten & Freunde" aria-label="Direktnachrichten" onClick={() => selectServer(null)}>
          <Icon.Chat size={22} class="" />
        </button>
        {hb > 0 && <span class="rail-badge">{hb}</span>}
      </div>
      <div class="rail-sep" />
      {servers.value.map((s) => (
        <ServerButton key={s.id} s={s} />
      ))}
      <div class="rail-item">
        <button class="rail-btn add" title="Server hinzufügen" aria-label="Server hinzufügen" onClick={() => openModal(<AddServerDialog />)}>
          <Icon.Plus size={22} class="" />
        </button>
      </div>
      <div class="rail-item">
        <button class="rail-btn add" title="Eigenen Server betreiben" aria-label="Eigenen Server betreiben" onClick={() => openModal(<HostDialog />)}>
          <Icon.ServerIcon size={20} class="" />
        </button>
      </div>
    </nav>
  );
}

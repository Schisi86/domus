// Middle column: channels of the active server (or DMs on the home screen),
// the active voice connection and the user panel with audio controls.

import { activeChannelId, activeServer, activeServerId, homeDm, isMuted, openDm, openModal, selectChannel, servers, settings, showMenu, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Channel } from "../types";
import { has, P } from "../types";
import { Avatar, IconButton, Icon, confirmDialog, copyText } from "./components";
import { joinVoice, endVoice, voice, voiceBusy } from "../rtc/voice";
import { ChannelDialog, CategoryDialog } from "./dialogs/Channels";
import { ServerSettingsDialog } from "./dialogs/ServerSettings";
import { InviteDialog } from "./dialogs/Invite";
import { AddServerDialog } from "./dialogs/AddServer";
import { UserSettingsDialog } from "./dialogs/UserSettings";
import { errorText, PRESENCE_TEXT } from "../i18n";
import { toast } from "../state/app";

function ConnBanner({ server }: { server: ServerStore }) {
  const st = server.conn.state.value;
  if (st === "ready") return null;
  const text =
    st === "auth_failed"
      ? server.conn.error.value ?? "Anmeldung abgelaufen."
      : st === "cert_untrusted" || st === "cert_mismatch"
        ? "Zertifikatsproblem – Verbindung blockiert."
        : st === "connecting"
          ? "Verbindung wird aufgebaut …"
          : "Verbindung unterbrochen – neuer Versuch läuft …";
  const fix = st === "auth_failed" || st.startsWith("cert");
  return (
    <div class={`conn-banner${fix ? " err" : ""}`} role="status">
      <span class="grow">{text}</span>
      {fix ? (
        <button class="btn sm" onClick={() => openModal(<AddServerDialog reauth={server} />)}>
          Beheben
        </button>
      ) : (
        <button class="btn sm" onClick={() => server.conn.retryNow()}>Jetzt</button>
      )}
    </div>
  );
}

function VoiceUsers({ server, channel }: { server: ServerStore; channel: Channel }) {
  const members = server.voiceMembers(channel.id);
  const v = voice.value;
  const speaking = v && v.server === server ? v.speaking.value : new Set<number>();
  if (!members.length) return null;
  return (
    <div class="voice-users">
      {members.map((m) => (
        <div class="voice-user" key={m.user_id}>
          <Avatar server={server} userId={m.user_id} name={server.memberName(m.user_id)} size={20} speaking={speaking.has(m.user_id)} />
          <span class="ellipsis">{server.memberName(m.user_id)}</span>
          <span class="flags">
            {m.screen && <span class="live-badge" title="Teilt den Bildschirm">LIVE</span>}
            {m.video && <Icon.Camera title="Kamera an" />}
            {(m.muted || m.suppressed) && <Icon.MicOff title="Stummgeschaltet" />}
            {m.deafened && <Icon.HeadphonesOff title="Ton aus" />}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChannelRow({ server, channel }: { server: ServerStore; channel: Channel }) {
  const active = activeChannelId.value === channel.id && activeServerId.value === server.id;
  const unread = channel.kind === "text" && server.isUnread(channel.id) && !isMuted(server.id, channel.id);
  const mentions = server.mentionCounts.value[channel.id] ?? 0;
  const canManage = has(channel.perms, P.MANAGE_CHANNELS);
  const muted = isMuted(server.id, channel.id);
  const click = () => {
    selectChannel(channel.id);
    if (channel.kind === "voice") {
      if (!has(channel.perms, P.CONNECT)) return toast("Kein Zutritt", "Dir fehlt die Berechtigung, diesem Sprachkanal beizutreten.", "warn");
      void joinVoice(server, channel.id);
    }
  };
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      ...(channel.kind === "text" ? [{ label: "Als gelesen markieren", onClick: () => void server.ack(channel.id) }] : []),
      {
        label: muted ? "Stummschaltung aufheben" : "Kanal stummschalten",
        onClick: () => updateSettings({ muted: { ...settings.value.muted, [`${server.id}:${channel.id}`]: !muted } }),
      },
      { label: "Kanal-ID kopieren", onClick: () => copyText(String(channel.id)) },
      ...(canManage
        ? [
            { separator: true, label: "" },
            { label: "Kanal bearbeiten", onClick: () => openModal(<ChannelDialog server={server} channel={channel} />) },
            {
              label: "Kanal löschen",
              danger: true,
              onClick: async () => {
                if (await confirmDialog({ title: "Kanal löschen?", body: `#${channel.name} und alle Nachrichten darin werden endgültig gelöscht.`, confirm: "Löschen", danger: true })) {
                  server.rpc("channel.delete", { channel_id: channel.id }).catch((err) => toast("Löschen fehlgeschlagen", errorText(err), "error"));
                }
              },
            },
          ]
        : []),
    ]);
  return (
    <>
      <button class={`chan${active ? " active" : ""}${unread ? " unread" : ""}`} onClick={click} onContextMenu={menu} title={channel.topic || channel.name}>
        {channel.kind === "voice" ? <Icon.Speaker /> : <Icon.Hash />}
        <span class="name">{channel.name}</span>
        {muted && <Icon.BellOff size={14} />}
        {mentions > 0 && <span class="mention-count">{mentions}</span>}
        {canManage && (
          <span class="chan-actions">
            <span
              class="icon-btn sm"
              role="button"
              title="Kanal bearbeiten"
              onClick={(e) => {
                e.stopPropagation();
                openModal(<ChannelDialog server={server} channel={channel} />);
              }}
            >
              <Icon.Gear />
            </span>
          </span>
        )}
      </button>
      {channel.kind === "voice" && <VoiceUsers server={server} channel={channel} />}
    </>
  );
}

function ServerSidebar({ server }: { server: ServerStore }) {
  const cats = server.categories.value;
  const chans = server.channels.value.slice().sort((a, b) => a.position - b.position || a.id - b.id);
  const uncategorized = chans.filter((c) => c.category_id === null || !cats.some((x) => x.id === c.category_id));
  const canCreate = server.can(P.CREATE_CHANNELS);
  const headMenu = (e: MouseEvent) =>
    showMenu(e, [
      ...(server.can(P.CREATE_INVITES) ? [{ label: "Personen einladen", onClick: () => openModal(<InviteDialog server={server} />) }] : []),
      { label: "Servereinstellungen", onClick: () => openModal(<ServerSettingsDialog server={server} />) },
      ...(canCreate
        ? [
            { label: "Kanal erstellen", onClick: () => openModal(<ChannelDialog server={server} />) },
            { label: "Kategorie erstellen", onClick: () => openModal(<CategoryDialog server={server} />) },
          ]
        : []),
      {
        label: isMuted(server.id) ? "Benachrichtigungen aktivieren" : "Server stummschalten",
        onClick: () => updateSettings({ muted: { ...settings.value.muted, [server.id]: !isMuted(server.id) } }),
      },
    ]);
  return (
    <>
      <div class="sidebar-head" onClick={headMenu} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && headMenu(e as unknown as MouseEvent)}>
        <span class="title ellipsis">{server.displayName()}</span>
        <Icon.ChevronDown />
      </div>
      <ConnBanner server={server} />
      <div class="sidebar-scroll">
        {uncategorized.map((c) => (
          <ChannelRow key={c.id} server={server} channel={c} />
        ))}
        {cats.map((cat) => {
          const list = chans.filter((c) => c.category_id === cat.id);
          return (
            <div class="cat" key={cat.id}>
              <div class="cat-head" onContextMenu={(e) =>
                server.can(P.MANAGE_CHANNELS) &&
                showMenu(e, [
                  { label: "Kategorie bearbeiten", onClick: () => openModal(<CategoryDialog server={server} category={cat} />) },
                  {
                    label: "Kategorie löschen",
                    danger: true,
                    onClick: () => server.rpc("category.delete", { category_id: cat.id }).catch((err) => toast("Fehler", errorText(err), "error")),
                  },
                ])
              }>
                <span class="grow ellipsis">{cat.name}</span>
                {canCreate && (
                  <IconButton title="Kanal erstellen" onClick={() => openModal(<ChannelDialog server={server} categoryId={cat.id} />)}>
                    <Icon.Plus />
                  </IconButton>
                )}
              </div>
              {list.map((c) => (
                <ChannelRow key={c.id} server={server} channel={c} />
              ))}
            </div>
          );
        })}
        {server.conn.state.value === "ready" && !chans.length && <div class="faint small" style={{ padding: "12px" }}>Keine sichtbaren Kanäle.</div>}
      </div>
    </>
  );
}

function HomeSidebar() {
  const entries = servers.value.flatMap((s) =>
    s.dms.value.map((d) => ({ s, d, last: d.last_message_id ?? 0 })),
  );
  entries.sort((a, b) => b.last - a.last);
  const cur = homeDm.value;
  return (
    <>
      <div class="sidebar-head">
        <span class="title">Direktnachrichten</span>
      </div>
      <div class="sidebar-scroll">
        <button class={`chan${!cur ? " active" : ""}`} onClick={() => (homeDm.value = null)}>
          <Icon.Users />
          <span class="name">Freunde</span>
        </button>
        <div class="cat-head" style={{ marginTop: "14px" }}>Unterhaltungen</div>
        {entries.map(({ s, d }) => {
          const m = s.member(d.user_id);
          const active = cur?.serverId === s.id && cur.channelId === d.channel_id;
          const unread = s.isUnread(d.channel_id);
          const inCall = s.voiceMembers(d.channel_id).length > 0;
          return (
            <button key={`${s.id}:${d.channel_id}`} class={`chan${active ? " active" : ""}${unread ? " unread" : ""}`} style={{ height: "44px" }} onClick={() => openDm(s, d.channel_id)}>
              <Avatar server={s} userId={d.user_id} name={s.memberName(d.user_id)} size={30} presence={m?.presence ?? "offline"} />
              <span class="name">
                <div class="ellipsis">{s.memberName(d.user_id)}</div>
                <div class="faint xs ellipsis">{servers.value.length > 1 ? s.displayName() : (m?.status_text ?? "")}</div>
              </span>
              {inCall && <Icon.Speaker size={16} title="Anruf aktiv" />}
            </button>
          );
        })}
        {!entries.length && <div class="faint small" style={{ padding: "8px 10px" }}>Noch keine Direktnachrichten. Öffne ein Profil in der Mitgliederliste, um eine Unterhaltung zu beginnen.</div>}
      </div>
    </>
  );
}

const QUALITY_TEXT = { good: "Sprachverbindung", ok: "Verbindung mäßig", bad: "Schlechte Verbindung", connecting: "Verbinde …", alone: "Sprachverbindung" };

function VoicePanel() {
  const v = voice.value;
  if (!v) return null;
  const q = v.state.value === "reconnecting" ? "connecting" : v.overallQuality();
  const ch = v.server.channel(v.channelId);
  const dm = v.server.dm(v.channelId);
  const where = ch ? `${ch.name} / ${v.server.displayName()}` : dm ? `Anruf mit ${v.server.memberName(dm.user_id)}` : "";
  const stats = [...v.stats.value.values()];
  const rtts = stats.map((s) => s.rtt).filter((x): x is number => x !== null);
  const relay = stats.some((s) => s.relay);
  const detail = rtts.length ? `${Math.max(...rtts)} ms${relay ? " · über Relay" : ""}` : v.peerIds().length ? "Verbindungsaufbau" : "Allein im Kanal";
  return (
    <div class="voice-panel">
      <div class="row">
        <div class="grow" style={{ minWidth: "0px" }}>
          <div class={`status ${q === "alone" ? "good" : q === "connecting" ? "ok" : q}`} title={detail}>
            <Icon.Signal size={16} />
            {QUALITY_TEXT[q]}
          </div>
          <div class="faint xs ellipsis" title={where}>{where}</div>
          <div class="faint xs">{detail}</div>
        </div>
        <IconButton title="Verbindung trennen" class="on-danger" onClick={() => void endVoice()}>
          <Icon.PhoneOff />
        </IconButton>
      </div>
      <div class="controls">
        <button class={`btn${v.sharingScreen.value ? " on" : ""}`} title={v.sharingScreen.value ? "Übertragung beenden" : "Bildschirm übertragen"} onClick={() => (v.sharingScreen.value ? v.stopScreen() : v.startScreen())}>
          {v.sharingScreen.value ? <Icon.ScreenOff /> : <Icon.Screen />}
        </button>
        <button class={`btn${v.cameraOn.value ? " on" : ""}`} title={v.cameraOn.value ? "Kamera aus" : "Kamera an"} onClick={() => (v.cameraOn.value ? v.stopCamera() : v.startCamera())}>
          {v.cameraOn.value ? <Icon.Camera /> : <Icon.CameraOff />}
        </button>
      </div>
      {v.sharingScreen.value && <div class="faint xs" style={{ marginTop: "6px" }}>🔴 Dein Bildschirm wird übertragen{v.screenHasAudio.value ? " (mit Ton)" : ""}.</div>}
    </div>
  );
}

function UserPanel() {
  const server = activeServer.value ?? servers.value.find((s) => s.me.value) ?? null;
  const me = server?.me.value;
  const v = voice.value;
  const muted = v ? v.muted.value || !v.hasMic.value : false;
  const deaf = v ? v.deafened.value : false;
  const presence = me?.presence ?? "online";
  return (
    <div class="user-panel">
      <div class="who" onClick={() => openModal(<UserSettingsDialog />)} title="Profil & Einstellungen">
        {me && server ? (
          <>
            <Avatar server={server} userId={me.id} name={me.display_name || me.username} size={32} presence={presence === "invisible" ? "offline" : presence} speaking={v?.speaking.value.has(me.id)} />
            <div class="names">
              <div class="ellipsis" style={{ fontWeight: 600 }}>{me.display_name || me.username}</div>
              <div class="faint xs ellipsis">{me.status_text || PRESENCE_TEXT[presence]}</div>
            </div>
          </>
        ) : (
          <div class="faint small">Nicht angemeldet</div>
        )}
      </div>
      <IconButton
        title={!v ? "Mikrofon (nur im Sprachkanal)" : muted ? "Stummschaltung aufheben" : "Stummschalten"}
        class={muted ? "on-danger" : ""}
        disabled={!v || voiceBusy.value}
        onClick={() => v && v.hasMic.value && void v.setMuted(!v.muted.value)}
      >
        {muted ? <Icon.MicOff /> : <Icon.Mic />}
      </IconButton>
      <IconButton title={deaf ? "Ton einschalten" : "Ton ausschalten"} class={deaf ? "on-danger" : ""} disabled={!v} onClick={() => v && void v.setDeafened(!v.deafened.value)}>
        {deaf ? <Icon.HeadphonesOff /> : <Icon.Headphones />}
      </IconButton>
      <IconButton title="Einstellungen" onClick={() => openModal(<UserSettingsDialog />)}>
        <Icon.Gear />
      </IconButton>
    </div>
  );
}

export function Sidebar() {
  const server = activeServer.value;
  return (
    <aside class="sidebar" aria-label="Kanäle">
      {activeServerId.value === null ? <HomeSidebar /> : server ? <ServerSidebar server={server} /> : null}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

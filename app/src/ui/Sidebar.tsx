// Middle column: channels of the active server (or DMs on the home screen),
// the active voice connection and the user panel with audio controls.

import { activeChannelId, activeServer, activeServerId, homeDm, isMuted, openDm, openModal, selectChannel, servers, settings, showMenu, toast, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Channel } from "../types";
import { has, P } from "../types";
import { Avatar, IconButton, Icon, Popover, confirmDialog, copyText } from "./components";
import { joinVoice, endVoice, voice, voiceBusy } from "../rtc/voice";
import { ChannelDialog, CategoryDialog } from "./dialogs/Channels";
import { ServerSettingsDialog } from "./dialogs/ServerSettings";
import { InviteDialog } from "./dialogs/Invite";
import { AddServerDialog } from "./dialogs/AddServer";
import { UserSettingsDialog } from "./dialogs/UserSettings";
import { errorText, presenceText, t } from "../i18n";
import { ScreenShareControl } from "./ScreenShare";
import { memberMenu } from "./Members";
import { SOUNDBOARD, playBoard } from "../sound";
import { useState } from "preact/hooks";

function ConnBanner({ server }: { server: ServerStore }) {
  const st = server.conn.state.value;
  if (st === "ready") return null;
  const text =
    st === "auth_failed"
      ? (server.conn.error.value ?? t("conn.authExpired"))
      : st === "cert_untrusted" || st === "cert_mismatch"
        ? t("conn.certBlocked")
        : st === "connecting"
          ? t("conn.connecting")
          : t("conn.retrying");
  const fix = st === "auth_failed" || st.startsWith("cert");
  return (
    <div class={`conn-banner${fix ? " err" : ""}`} role="status">
      <span class="grow">{text}</span>
      {fix ? (
        <button class="btn sm" onClick={() => openModal(<AddServerDialog reauth={server} />)}>{t("conn.fix")}</button>
      ) : (
        <button class="btn sm" onClick={() => server.conn.retryNow()}>{t("conn.now")}</button>
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
        <div
          class="voice-user"
          key={m.user_id}
          onContextMenu={(e) => {
            const mem = server.member(m.user_id);
            if (mem) memberMenu(e, server, mem);
          }}
        >
          <Avatar server={server} userId={m.user_id} name={server.memberName(m.user_id)} size={20} speaking={speaking.has(m.user_id)} />
          <span class="ellipsis">{server.memberName(m.user_id)}</span>
          <span class="flags">
            {m.hand && <span title={t("call.handRaised")}>✋</span>}
            {m.screen && <span class="live-badge" title={t("voice.sharingScreen")}>LIVE</span>}
            {m.video && <Icon.Webcam title={t("voice.cameraOn")} />}
            {m.server_muted ? <span class="mod-flag"><Icon.MicOff title={t("mod.serverMuted")} /></span> : (m.muted || m.suppressed) && <Icon.MicOff title={t("voice.muted")} />}
            {m.server_deafened ? <span class="mod-flag"><Icon.HeadphonesOff title={t("mod.serverDeafened")} /></span> : m.deafened && <Icon.HeadphonesOff title={t("voice.deafened")} />}
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
      if (!has(channel.perms, P.CONNECT)) return toast(t("chan.noAccess"), t("chan.noAccessBody"), "warn");
      void joinVoice(server, channel.id);
    }
  };
  const menu = (e: MouseEvent) =>
    showMenu(e, [
      ...(channel.kind === "text" ? [{ label: t("rail.markRead"), onClick: () => void server.ack(channel.id) }] : []),
      {
        label: muted ? t("chan.unmute") : t("chan.mute"),
        onClick: () => updateSettings({ muted: { ...settings.value.muted, [`${server.id}:${channel.id}`]: !muted } }),
      },
      { label: t("chan.copyId"), onClick: () => copyText(String(channel.id)) },
      ...(canManage
        ? [
            { separator: true, label: "" },
            { label: t("chan.edit"), onClick: () => openModal(<ChannelDialog server={server} channel={channel} />) },
            {
              label: t("chan.delete"),
              danger: true,
              onClick: async () => {
                if (await confirmDialog({ title: t("chan.deleteTitle"), body: t("chan.deleteBody", { name: channel.name }), confirm: t("common.delete"), danger: true })) {
                  server.rpc("channel.delete", { channel_id: channel.id }).catch((err) => toast(t("common.deleteFailed"), errorText(err), "error"));
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
        {channel.kind === "voice" && (channel.user_limit ?? 0) > 0 && (
          <span class="limit-badge" title={t("chanDlg.userLimit")}>{server.voiceMembers(channel.id).length}/{channel.user_limit}</span>
        )}
        {channel.kind === "text" && (channel.slowmode ?? 0) > 0 && <Icon.Clock size={13} title={t("chanDlg.slowmode")} />}
        {muted && <Icon.BellOff size={14} />}
        {mentions > 0 && <span class="mention-count">{mentions}</span>}
        {canManage && (
          <span class="chan-actions">
            <span
              class="icon-btn sm"
              role="button"
              title={t("chan.edit")}
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
      ...(server.can(P.CREATE_INVITES) ? [{ label: t("rail.invite"), onClick: () => openModal(<InviteDialog server={server} />) }] : []),
      { label: t("rail.serverSettings"), onClick: () => openModal(<ServerSettingsDialog server={server} />) },
      ...(canCreate
        ? [
            { label: t("chan.create"), onClick: () => openModal(<ChannelDialog server={server} />) },
            { label: t("cat.create"), onClick: () => openModal(<CategoryDialog server={server} />) },
          ]
        : []),
      {
        label: isMuted(server.id) ? t("rail.unmute") : t("rail.mute"),
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
              <div
                class="cat-head"
                onContextMenu={(e) =>
                  server.can(P.MANAGE_CHANNELS) &&
                  showMenu(e, [
                    { label: t("cat.edit"), onClick: () => openModal(<CategoryDialog server={server} category={cat} />) },
                    {
                      label: t("cat.delete"),
                      danger: true,
                      onClick: () => server.rpc("category.delete", { category_id: cat.id }).catch((err) => toast(t("common.error"), errorText(err), "error")),
                    },
                  ])
                }
              >
                <span class="grow ellipsis">{cat.name}</span>
                {canCreate && (
                  <IconButton title={t("chan.create")} onClick={() => openModal(<ChannelDialog server={server} categoryId={cat.id} />)}>
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
        {server.conn.state.value === "ready" && !chans.length && <div class="faint small" style={{ padding: "12px" }}>{t("chan.noneVisible")}</div>}
      </div>
    </>
  );
}

function HomeSidebar() {
  const entries = servers.value.flatMap((s) => s.dms.value.map((d) => ({ s, d, last: d.last_message_id ?? 0 })));
  entries.sort((a, b) => b.last - a.last);
  const cur = homeDm.value;
  return (
    <>
      <div class="sidebar-head">
        <span class="title">{t("home.dms")}</span>
      </div>
      <div class="sidebar-scroll">
        <button class={`chan${!cur ? " active" : ""}`} onClick={() => (homeDm.value = null)}>
          <Icon.Mail />
          <span class="name">{t("home.friends")}</span>
        </button>
        <div class="cat-head" style={{ marginTop: "14px" }}>{t("home.conversations")}</div>
        {entries.map(({ s, d }) => {
          const m = s.member(d.user_id);
          const active = cur?.serverId === s.id && cur.channelId === d.channel_id;
          const unread = s.isUnread(d.channel_id);
          const inCall = s.voiceMembers(d.channel_id).length > 0;
          return (
            <button key={`${s.id}:${d.channel_id}`} class={`chan${active ? " active" : ""}${unread ? " unread" : ""}`} style={{ height: "44px" }} onClick={() => openDm(s, d.channel_id)}>
              <Avatar server={s} userId={d.user_id} name={s.dmName(d.user_id)} size={30} presence={m?.presence ?? "offline"} />
              <span class="name">
                <div class="ellipsis">{s.dmName(d.user_id)}</div>
                <div class="faint xs ellipsis">{servers.value.length > 1 ? s.displayName() : (m?.status_text ?? "")}</div>
              </span>
              {inCall && <Icon.Speaker size={16} title={t("home.callActive")} />}
            </button>
          );
        })}
        {!entries.length && <div class="faint small" style={{ padding: "8px 10px" }}>{t("home.noDms")}</div>}
      </div>
    </>
  );
}

/** Soundboard: short sounds everyone in the channel hears. Clicks play
 *  instantly and overlap; the mute and volume controls are in the menu. */
function SoundboardButton({ v }: { v: NonNullable<typeof voice.value> }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const s = settings.value;
  const blocked = v.suppressed.value || v.serverMuted.value;
  const fire = (id: string) => {
    // Heard locally at once (overlapping, no cooldown); also sent to the channel.
    void playBoard(id, s.soundboardVolume, true);
    v.playSound(id).catch(() => {});
  };
  return (
    <>
      <button class={`btn${anchor ? " on" : ""}`} title={blocked ? t("board.blocked") : t("board.title")} disabled={blocked} onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <Icon.Music />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div class="soundboard">
            <div class="sb-grid">
              {SOUNDBOARD.map((snd) => (
                <button key={snd.id} class="sb-btn" onClick={() => fire(snd.id)} title={t(`board.${snd.id}` as "board.airhorn")} aria-label={t(`board.${snd.id}` as "board.airhorn")}>
                  <span class="e">{snd.emoji}</span>
                </button>
              ))}
            </div>
            <div class="sb-bar">
              <button
                class={`sb-mute${s.soundboard ? "" : " off"}`}
                title={s.soundboard ? t("board.mute") : t("board.unmute")}
                aria-label={s.soundboard ? t("board.mute") : t("board.unmute")}
                onClick={() => updateSettings({ soundboard: !s.soundboard })}
              >
                {s.soundboard ? <Icon.Volume size={16} /> : <Icon.VolumeOff size={16} />}
              </button>
              <input
                class="range grow"
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={s.soundboardVolume}
                disabled={!s.soundboard}
                aria-label={t("snd.volume")}
                onInput={(e) => updateSettings({ soundboardVolume: Number((e.target as HTMLInputElement).value) })}
                onChange={() => s.soundboard && void playBoard("bell", s.soundboardVolume, true)}
              />
              <span class="faint xs sb-pct">{Math.round(s.soundboardVolume * 100)}%</span>
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

function VoicePanel() {
  const v = voice.value;
  if (!v) return null;
  const q = v.state.value === "reconnecting" ? "connecting" : v.overallQuality();
  const ch = v.server.channel(v.channelId);
  const dm = v.server.dm(v.channelId);
  const where = ch ? `${ch.name} / ${v.server.displayName()}` : dm ? t("voice.callWith", { name: v.server.memberName(dm.user_id) }) : "";
  const stats = [...v.stats.value.values()];
  const rtts = stats.map((s) => s.rtt).filter((x): x is number => x !== null);
  const relay = stats.some((s) => s.relay);
  const detail = rtts.length ? `${Math.max(...rtts)} ms${relay ? ` · ${t("voice.viaRelay")}` : ""}` : v.peerIds().length ? t("voice.establishing") : t("voice.alone");
  const qText = { good: t("voice.q.good"), ok: t("voice.q.ok"), bad: t("voice.q.bad"), connecting: t("voice.q.connecting"), alone: t("voice.q.good") }[q];
  return (
    <div class="voice-panel">
      <div class="row">
        <div class="grow" style={{ minWidth: "0px" }}>
          <div class={`status ${q === "alone" ? "good" : q === "connecting" ? "ok" : q}`} title={detail}>
            <Icon.Signal size={15} />
            {qText}
          </div>
          <div class="faint xs ellipsis" title={where}>{where}</div>
          <div class="faint xs">{detail}</div>
        </div>
        <IconButton title={t("voice.disconnect")} class="on-danger" onClick={() => void endVoice()}>
          <Icon.PhoneOff />
        </IconButton>
      </div>
      <div class="controls">
        <ScreenShareControl v={v} variant="panel" />
        <button class={`btn${v.cameraOn.value ? " on" : ""}`} title={v.cameraOn.value ? t("voice.cameraOff") : t("voice.cameraOnAction")} onClick={() => (v.cameraOn.value ? v.stopCamera() : v.startCamera())}>
          {v.cameraOn.value ? <Icon.Webcam /> : <Icon.WebcamOff />}
        </button>
        <SoundboardButton v={v} />
      </div>
      {(v.serverMuted.value || v.serverDeafened.value) && (
        <div class="notice warn xs" style={{ marginTop: "6px" }}>{v.serverDeafened.value ? t("voice.serverDeafenedBody") : t("voice.serverMutedBody")}</div>
      )}
      {v.sharingScreen.value && <div class="faint xs" style={{ marginTop: "6px" }}>🔴 {v.screenHasAudio.value ? t("voice.sharingWithAudio") : t("voice.sharingNow")}</div>}
    </div>
  );
}

function UserPanel() {
  const server = activeServer.value ?? servers.value.find((s) => s.me.value) ?? null;
  const me = server?.me.value;
  const v = voice.value;
  const muted = v ? v.muted.value || !v.hasMic.value || v.serverMuted.value : false;
  const deaf = v ? v.deafened.value : false;
  const presence = me?.presence ?? "online";
  return (
    <div class="user-panel">
      <div class="who" onClick={() => openModal(<UserSettingsDialog />)} title={t("user.profileSettings")}>
        {me && server ? (
          <>
            <Avatar server={server} userId={me.id} name={me.display_name || me.username} size={32} presence={presence === "invisible" ? "offline" : presence} speaking={v?.speaking.value.has(me.id)} />
            <div class="names">
              <div class="ellipsis" style={{ fontWeight: 600 }}>{me.display_name || me.username}</div>
              <div class="faint xs ellipsis">{me.status_text || presenceText(presence)}</div>
            </div>
          </>
        ) : (
          <div class="faint small">{t("user.notSignedIn")}</div>
        )}
      </div>
      <IconButton
        title={!v ? t("user.micOnlyInVoice") : muted ? t("voice.unmute") : t("voice.mute")}
        class={muted ? "on-danger" : ""}
        disabled={!v || voiceBusy.value}
        onClick={() => v && v.hasMic.value && void v.setMuted(!v.muted.value)}
      >
        {muted ? <Icon.MicOff /> : <Icon.Mic />}
      </IconButton>
      <IconButton title={deaf ? t("voice.undeafen") : t("voice.deafen")} class={deaf ? "on-danger" : ""} disabled={!v} onClick={() => v && void v.setDeafened(!v.deafened.value)}>
        {deaf ? <Icon.HeadphonesOff /> : <Icon.Headphones />}
      </IconButton>
      <IconButton title={t("settings.title")} onClick={() => openModal(<UserSettingsDialog />)}>
        <Icon.Gear />
      </IconButton>
    </div>
  );
}

export function Sidebar() {
  const server = activeServer.value;
  return (
    <aside class="sidebar" aria-label={t("chan.channels")}>
      {activeServerId.value === null ? <HomeSidebar /> : server ? <ServerSidebar server={server} /> : null}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

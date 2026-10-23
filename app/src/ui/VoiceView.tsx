// Voice channel view: participant tiles, screen shares, cameras, controls.

import { useState } from "preact/hooks";
import { openModal, settings } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Channel } from "../types";
import { has, P } from "../types";
import { t } from "../i18n";
import { Avatar, EmptyState, IconButton, Icon } from "./components";
import { VideoTile } from "./Chat";
import { endVoice, joinVoice, voice, voiceBusy } from "../rtc/voice";
import { ScreenQualityChip, ScreenShareControl } from "./ScreenShare";
import { UserSettingsDialog } from "./dialogs/UserSettings";

export function VoiceView({ server, channel }: { server: ServerStore; channel: Channel }) {
  const v = voice.value;
  const inHere = v && v.server === server && v.channelId === channel.id;
  const members = server.voiceMembers(channel.id);
  const [focus, setFocus] = useState<string | null>(null);

  if (!inHere) {
    const can = has(channel.perms, P.CONNECT);
    return (
      <EmptyState title={channel.name}>
        <p class="muted">{members.length ? t("voice.inChannel", { n: members.length, names: members.map((m) => server.memberName(m.user_id)).join(", ") }) : t("voice.nobody")}</p>
        <button class="btn primary lg" disabled={!can || voiceBusy.value} onClick={() => void joinVoice(server, channel.id)}>
          <Icon.Speaker /> {voiceBusy.value ? t("voice.connecting") : t("voice.join")}
        </button>
        {!can && <p class="error-text">{t("chan.noAccessBody")}</p>}
      </EmptyState>
    );
  }

  const speaking = v.speaking.value;
  const stats = v.stats.value;
  const screens = [...v.screens.value.entries()];
  const cams = v.cameras.value;
  const focused = focus ? screens.find(([uid]) => `s${uid}` === focus) : undefined;
  const canShare = has(channel.perms, P.SCREEN_SHARE);
  const canVideo = has(channel.perms, P.VIDEO);

  const participantTile = (uid: number) => {
    const m = members.find((x) => x.user_id === uid);
    const cam = cams.get(uid);
    const st = stats.get(uid);
    const name = server.memberName(uid);
    const label = (
      <>
        {name}
        {(m?.muted || m?.suppressed) && <Icon.MicOff size={13} />}
        {m?.deafened && <Icon.HeadphonesOff size={13} />}
        {st && st.quality !== "good" && <span class={`status ${st.quality === "connecting" ? "ok" : st.quality}`} title={st.rtt ? `${st.rtt} ms` : st.state}>●</span>}
        {st?.relay && <span class="xs" title={t("voice.relayHint")}>Relay</span>}
      </>
    );
    if (cam) {
      return (
        <div class={`tile${speaking.has(uid) ? " speaking" : ""}`} key={`p${uid}`}>
          <VideoTile stream={cam} label="" muted />
          <div class="tile-label">{label}</div>
        </div>
      );
    }
    return (
      <div class={`tile${speaking.has(uid) ? " speaking" : ""}`} key={`p${uid}`}>
        <Avatar server={server} userId={uid} name={name} size={80} speaking={speaking.has(uid)} />
        <div class="tile-label">{label}</div>
      </div>
    );
  };

  const screenTile = ([uid, stream]: [number, MediaStream], big = false) => (
    <VideoTile
      key={`s${uid}`}
      stream={stream}
      label={`${server.memberName(uid)} – ${t("voice.screen")}${uid === v.selfId ? ` (${t("voice.preview")})` : ""}`}
      muted
      onClick={() => setFocus(focus === `s${uid}` ? null : `s${uid}`)}
    >
      <div class="tile-tools">
        <IconButton
          title={t("voice.fullscreen")}
          onClick={(e) => {
            e.stopPropagation();
            ((e.currentTarget as HTMLElement).closest(".tile")?.querySelector("video") as HTMLVideoElement | null)?.requestFullscreen?.();
          }}
        >
          <Icon.Maximize />
        </IconButton>
        {big && (
          <IconButton title={t("voice.shrink")} onClick={(e) => { e.stopPropagation(); setFocus(null); }}>
            <Icon.X />
          </IconButton>
        )}
      </div>
    </VideoTile>
  );

  const ids = [v.selfId, ...members.map((m) => m.user_id).filter((u) => u !== v.selfId)];

  return (
    <div class="voice-view">
      <header class="main-head" style={{ background: "transparent" }}>
        <div class="chan-title"><Icon.Speaker /> {channel.name}</div>
        <div class="grow faint small">{v.state.value === "reconnecting" ? t("voice.restoring") : t("voice.participants", { n: members.length })}</div>
        {v.sharingScreen.value && <ScreenQualityChip v={v} />}
      </header>
      {focused ? (
        <div class="voice-grid has-focus">
          {screenTile(focused, true)}
          <div class="voice-strip" style={{ padding: "0px" }}>
            {screens.filter((s) => s !== focused).map((s) => screenTile(s))}
            {ids.map(participantTile)}
          </div>
        </div>
      ) : (
        <div class="voice-grid">
          {screens.map((s) => screenTile(s))}
          {ids.map(participantTile)}
        </div>
      )}
      {v.sharingScreen.value && <div class="notice warn" style={{ margin: "0 14px 6px" }}>🔴 {v.screenHasAudio.value ? t("voice.sharingNoticeAudio") : t("voice.sharingNotice")}</div>}
      {!v.hasMic.value && <div class="notice warn" style={{ margin: "0 14px 6px" }}>{t("voice.noMicNotice")}</div>}
      {v.suppressed.value && <div class="notice" style={{ margin: "0 14px 6px" }}>{t("voice.suppressed")}</div>}
      {settings.value.pushToTalk && v.hasMic.value && (
        <div class="faint small" style={{ textAlign: "center" }}>
          {t("voice.pttHint", { key: (settings.value.globalPtt ? settings.value.globalPttKey : settings.value.pttKey).replace(/^Key/, "") })}
          {v.pttDown.value ? ` – ${t("voice.transmitting")}` : ""}
        </div>
      )}
      <div class="voice-controls">
        <button class={`round-btn${v.muted.value || !v.hasMic.value ? " off" : ""}`} title={v.muted.value ? t("voice.unmute") : t("voice.mute")} disabled={!v.hasMic.value} onClick={() => void v.setMuted(!v.muted.value)}>
          {v.muted.value || !v.hasMic.value ? <Icon.MicOff /> : <Icon.Mic />}
        </button>
        <button class={`round-btn${v.deafened.value ? " off" : ""}`} title={v.deafened.value ? t("voice.undeafen") : t("voice.deafen")} onClick={() => void v.setDeafened(!v.deafened.value)}>
          {v.deafened.value ? <Icon.HeadphonesOff /> : <Icon.Headphones />}
        </button>
        <button class={`round-btn${v.cameraOn.value ? " on" : ""}`} title={!canVideo ? t("common.noPermission") : v.cameraOn.value ? t("voice.cameraOff") : t("voice.cameraOnAction")} disabled={!canVideo} onClick={() => void (v.cameraOn.value ? v.stopCamera() : v.startCamera())}>
          {v.cameraOn.value ? <Icon.Camera /> : <Icon.CameraOff />}
        </button>
        <ScreenShareControl v={v} variant="round" disabled={!canShare} />
        <button class="round-btn" title={t("settings.voice")} onClick={() => openModal(<UserSettingsDialog tab="voice" />)}>
          <Icon.Gear />
        </button>
        <button class="round-btn leave" title={t("voice.leave")} onClick={() => void endVoice()}>
          <Icon.PhoneOff />
        </button>
      </div>
    </div>
  );
}

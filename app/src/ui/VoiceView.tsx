// Voice channel view: participant tiles, screen shares, cameras, controls.

import { useState } from "preact/hooks";
import { openModal, settings, updateSettings } from "../state/app";
import type { ServerStore } from "../state/server";
import type { Channel } from "../types";
import { has, P } from "../types";
import { Avatar, EmptyState, IconButton, Icon } from "./components";
import { VideoTile } from "./Chat";
import { endVoice, joinVoice, SCREEN_PROFILES, voice, voiceBusy } from "../rtc/voice";
import { UserSettingsDialog } from "./dialogs/UserSettings";

export function VoiceView({ server, channel }: { server: ServerStore; channel: Channel }) {
  const v = voice.value;
  const inHere = v && v.server === server && v.channelId === channel.id;
  const members = server.voiceMembers(channel.id);
  const [focus, setFocus] = useState<string | null>(null);

  if (!inHere) {
    const can = has(channel.perms, P.CONNECT);
    return (
      <EmptyState title={channel.name} icon={<div class="logo-mark"><Icon.Speaker size={34} class="" /></div>}>
        <p class="muted">{members.length ? `${members.length} Person(en) im Kanal: ${members.map((m) => server.memberName(m.user_id)).join(", ")}` : "Niemand ist gerade hier."}</p>
        <button class="btn primary" disabled={!can || voiceBusy.value} onClick={() => void joinVoice(server, channel.id)}>
          {voiceBusy.value ? "Verbinde …" : "Sprachkanal beitreten"}
        </button>
        {!can && <p class="error-text">Dir fehlt die Berechtigung, diesem Kanal beizutreten.</p>}
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
  const profile = settings.value.screenProfile;

  const participantTile = (uid: number) => {
    const m = members.find((x) => x.user_id === uid);
    const cam = cams.get(uid);
    const st = stats.get(uid);
    const name = server.memberName(uid);
    const label = (
      <>
        {name}
        {(m?.muted || m?.suppressed) && <Icon.MicOff size={14} />}
        {m?.deafened && <Icon.HeadphonesOff size={14} />}
        {st && st.quality !== "good" && <span class={`status ${st.quality === "connecting" ? "ok" : st.quality}`} title={st.rtt ? `${st.rtt} ms` : st.state}>●</span>}
        {st?.relay && <span class="xs" title="Verbindung läuft über den TURN-Relay">Relay</span>}
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
        <Avatar server={server} userId={uid} name={name} size={84} speaking={speaking.has(uid)} />
        <div class="tile-label">{label}</div>
      </div>
    );
  };

  const screenTile = ([uid, stream]: [number, MediaStream], big = false) => (
    <VideoTile
      key={`s${uid}`}
      stream={stream}
      label={`${server.memberName(uid)} – Bildschirm${uid === v.selfId ? " (Vorschau)" : ""}`}
      muted
      onClick={() => setFocus(focus === `s${uid}` ? null : `s${uid}`)}
    >
      <div class="tile-tools">
        <IconButton
          title="Vollbild"
          onClick={(e) => {
            e.stopPropagation();
            ((e.currentTarget as HTMLElement).closest(".tile")?.querySelector("video") as HTMLVideoElement | null)?.requestFullscreen?.();
          }}
        >
          <Icon.Maximize />
        </IconButton>
        {big && (
          <IconButton title="Verkleinern" onClick={(e) => { e.stopPropagation(); setFocus(null); }}>
            <Icon.X />
          </IconButton>
        )}
      </div>
    </VideoTile>
  );

  const ids = [v.selfId, ...members.map((m) => m.user_id).filter((u) => u !== v.selfId)];

  return (
    <div class="voice-view">
      <header class="main-head" style={{ background: "var(--bg-2)" }}>
        <div class="chan-title"><Icon.Speaker /> {channel.name}</div>
        <div class="grow faint small">{v.state.value === "reconnecting" ? "Verbindung wird wiederhergestellt …" : `${members.length} Teilnehmer`}</div>
        {v.sharingScreen.value && (
          <select
            class="select"
            style={{ width: "170px", height: "30px" }}
            value={profile}
            title="Übertragungsqualität"
            onChange={(e) => {
              updateSettings({ screenProfile: (e.target as HTMLSelectElement).value as typeof profile });
              void v.applyScreenProfile();
            }}
          >
            {Object.entries(SCREEN_PROFILES).map(([k, p]) => (
              <option value={k} key={k}>{p.label} ({p.height}p, {p.fps} FPS)</option>
            ))}
            <option value="manual">Manuell</option>
          </select>
        )}
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
      {v.sharingScreen.value && (
        <div class="notice warn" style={{ margin: "0 14px 6px" }}>
          🔴 Du überträgst deinen Bildschirm{v.screenHasAudio.value ? " inklusive Systemton" : " (ohne Systemton)"}. Beende die Übertragung jederzeit über die Schaltfläche unten.
        </div>
      )}
      {!v.hasMic.value && <div class="notice warn" style={{ margin: "0 14px 6px" }}>Kein Mikrofon aktiv – du kannst nur zuhören.</div>}
      {v.suppressed.value && <div class="notice" style={{ margin: "0 14px 6px" }}>Du hast in diesem Kanal kein Sprechrecht.</div>}
      {settings.value.pushToTalk && v.hasMic.value && (
        <div class="faint small" style={{ textAlign: "center" }}>
          Push-to-Talk: Taste <b>{settings.value.pttKey.replace(/^Key/, "")}</b> gedrückt halten{v.pttDown.value ? " – sendet …" : ""}
        </div>
      )}
      <div class="voice-controls">
        <button class={`round-btn${v.muted.value || !v.hasMic.value ? " off" : ""}`} title={v.muted.value ? "Stummschaltung aufheben" : "Stummschalten"} disabled={!v.hasMic.value} onClick={() => void v.setMuted(!v.muted.value)}>
          {v.muted.value || !v.hasMic.value ? <Icon.MicOff /> : <Icon.Mic />}
        </button>
        <button class={`round-btn${v.deafened.value ? " off" : ""}`} title={v.deafened.value ? "Ton einschalten" : "Ton ausschalten"} onClick={() => void v.setDeafened(!v.deafened.value)}>
          {v.deafened.value ? <Icon.HeadphonesOff /> : <Icon.Headphones />}
        </button>
        <button class={`round-btn${v.cameraOn.value ? " on" : ""}`} title={!canVideo ? "Keine Berechtigung" : v.cameraOn.value ? "Kamera ausschalten" : "Kamera einschalten"} disabled={!canVideo} onClick={() => void (v.cameraOn.value ? v.stopCamera() : v.startCamera())}>
          {v.cameraOn.value ? <Icon.Camera /> : <Icon.CameraOff />}
        </button>
        <button class={`round-btn${v.sharingScreen.value ? " on" : ""}`} title={!canShare ? "Keine Berechtigung" : v.sharingScreen.value ? "Übertragung beenden" : "Bildschirm oder Fenster übertragen"} disabled={!canShare} onClick={() => void (v.sharingScreen.value ? v.stopScreen() : v.startScreen())}>
          {v.sharingScreen.value ? <Icon.ScreenOff /> : <Icon.Screen />}
        </button>
        <button class="round-btn" title="Audio- & Videoeinstellungen" onClick={() => openModal(<UserSettingsDialog tab="voice" />)}>
          <Icon.Gear />
        </button>
        <button class="round-btn leave" title="Verlassen" onClick={() => void endVoice()}>
          <Icon.PhoneOff />
        </button>
      </div>
    </div>
  );
}

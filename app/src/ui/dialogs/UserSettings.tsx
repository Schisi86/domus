// User settings: account (per server), audio/video devices, screen sharing,
// notifications, appearance, app & diagnostics.

import { useEffect, useRef, useState } from "preact/hooks";
import { activeServer, closeModal, minimizeToTray, persistNow, removeServer, servers, settings, toast, updateSettings, type Settings } from "../../state/app";
import type { ServerStore } from "../../state/server";
import { errorText, PRESENCE_TEXT } from "../../i18n";
import { transport } from "../../net/transport";
import { appInfo, autostart, isTauri, openFolder, quitApp, type AppInfo } from "../../platform";
import { Avatar, Field, IconButton, Icon, Modal, Toggle, confirmDialog, promptDialog } from "../components";
import { SCREEN_PROFILES, voice } from "../../rtc/voice";

type Tab = "account" | "voice" | "screen" | "notify" | "look" | "app";

function Account() {
  const [sid, setSid] = useState(activeServer.value?.id ?? servers.value[0]?.id ?? "");
  const server = servers.value.find((s) => s.id === sid) ?? null;
  const me = server?.me.value;
  const [display, setDisplay] = useState(me?.display_name ?? "");
  const [status, setStatus] = useState(me?.status_text ?? "");
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  useEffect(() => {
    setDisplay(me?.display_name ?? "");
    setStatus(me?.status_text ?? "");
  }, [sid, me?.id]);
  if (!server || !me) return <div class="muted">Mit keinem Server verbunden.</div>;

  const saveProfile = () =>
    server.rpc("user.update", { display_name: display, status_text: status }).then(() => toast("Profil gespeichert", undefined, "ok"), (e) => toast("Fehler", errorText(e), "error"));
  const setPresence = (p: string) => server.rpc("user.presence", { presence: p }).then(() => (server.me.value = { ...me, presence: p as never }), (e) => toast("Fehler", errorText(e), "error"));
  const avatar = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast("Bild zu groß", "Maximal 2 MB.", "warn");
      const r = await transport.upload(server.target(), "/api/v1/avatar", server.token, f).catch((e) => ({ status: 0, body: { error: e } }));
      if (r.status === 200) toast("Avatar aktualisiert", undefined, "ok");
      else toast("Upload fehlgeschlagen", errorText(r.body?.error), "error");
    };
    input.click();
  };
  const changePw = async () => {
    try {
      await server.rpc("user.password", { old_password: oldPw, new_password: newPw });
      setOldPw("");
      setNewPw("");
      toast("Passwort geändert", "Andere Sitzungen wurden abgemeldet.", "ok");
    } catch (e) {
      toast("Passwort nicht geändert", errorText(e), "error");
    }
  };
  const logout = async () => {
    if (!(await confirmDialog({ title: "Abmelden?", body: `Du wirst von „${server.displayName()}“ abgemeldet und der Server wird aus der Liste entfernt.`, confirm: "Abmelden" }))) return;
    await transport.http(server.target(), "POST", "/api/v1/auth/logout", server.token).catch(() => {});
    removeServer(server.id);
    closeModal();
  };
  const deleteAccount = async () => {
    const pw = await promptDialog({
      title: "Konto löschen",
      body: `Dein Konto auf „${server.displayName()}“ wird dauerhaft gelöscht. Andere Server sind nicht betroffen.`,
      label: "Passwort zur Bestätigung",
      password: true,
      confirm: "Weiter",
      danger: true,
    });
    if (!pw) return;
    const withMsgs = await confirmDialog({ title: "Auch Nachrichten löschen?", body: "Sollen alle deine Nachrichten auf diesem Server ebenfalls gelöscht werden? Andernfalls bleiben sie als „Gelöschter Benutzer“ erhalten.", confirm: "Nachrichten löschen" });
    try {
      await server.rpc("user.delete_account", { password: pw, delete_messages: withMsgs });
      removeServer(server.id);
      closeModal();
      toast("Konto gelöscht", undefined, "ok");
    } catch (e) {
      toast("Löschen fehlgeschlagen", errorText(e), "error");
    }
  };

  return (
    <>
      <h2>Mein Konto</h2>
      {servers.value.length > 1 && (
        <Field label="Server" hint="Konten sind pro Server getrennt.">
          <select class="select" value={sid} onChange={(e) => setSid((e.target as HTMLSelectElement).value)}>
            {servers.value.map((s) => (
              <option key={s.id} value={s.id}>{s.displayName()}</option>
            ))}
          </select>
        </Field>
      )}
      <div class="card row" style={{ gap: "14px" }}>
        <Avatar server={server} userId={me.id} name={me.display_name || me.username} size={64} />
        <div class="grow">
          <div style={{ fontWeight: 700, fontSize: "var(--fs-lg)" }}>{me.display_name || me.username}</div>
          <div class="faint selectable">@{me.username}</div>
        </div>
        <button class="btn outline" onClick={avatar}>Avatar ändern</button>
        {me.avatar && <button class="btn ghost" onClick={() => transport.http(server.target(), "DELETE", "/api/v1/avatar", server.token)}>Entfernen</button>}
      </div>
      <Field label="Online-Status">
        <div class="tabs">
          {["online", "idle", "dnd", "invisible"].map((p) => (
            <button key={p} class={(me.presence ?? "online") === p ? "active" : ""} onClick={() => void setPresence(p)}>{PRESENCE_TEXT[p]}</button>
          ))}
        </div>
      </Field>
      <div class="row" style={{ gap: "12px", alignItems: "flex-end" }}>
        <Field label="Anzeigename"><input class="input" maxLength={32} value={display} onInput={(e) => setDisplay((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Statusmeldung"><input class="input" maxLength={128} value={status} onInput={(e) => setStatus((e.target as HTMLInputElement).value)} /></Field>
        <button class="btn primary" onClick={() => void saveProfile()}>Speichern</button>
      </div>
      <div class="card col">
        <div class="label">Passwort ändern</div>
        <div class="row" style={{ gap: "10px" }}>
          <input class="input" type="password" placeholder="Aktuelles Passwort" autoComplete="current-password" value={oldPw} onInput={(e) => setOldPw((e.target as HTMLInputElement).value)} />
          <input class="input" type="password" placeholder="Neues Passwort (min. 8)" autoComplete="new-password" value={newPw} onInput={(e) => setNewPw((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={!oldPw || newPw.length < 8} onClick={() => void changePw()}>Ändern</button>
        </div>
      </div>
      <div class="row">
        <button class="btn outline" onClick={() => void logout()}><Icon.Logout /> Abmelden</button>
        <span class="spacer" />
        <button class="btn ghost" style={{ color: "var(--danger)" }} onClick={() => void deleteAccount()}>Konto auf diesem Server löschen</button>
      </div>
    </>
  );
}

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, []);
  return devices;
}

function MicTest() {
  const [level, setLevel] = useState<number | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  const toggle = async () => {
    if (stop.current) {
      stop.current();
      stop.current = null;
      setLevel(null);
      return;
    }
    const st = settings.value;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: st.inputDevice ? { exact: st.inputDevice } : undefined, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl },
      });
      const ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      const t = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
      }, 80);
      stop.current = () => {
        clearInterval(t);
        stream.getTracks().forEach((x) => x.stop());
        void ctx.close();
      };
    } catch (e) {
      toast("Mikrofontest fehlgeschlagen", String(e), "error");
    }
  };
  return (
    <div class="row">
      <button class="btn" onClick={() => void toggle()}>{stop.current ? "Test beenden" : "Mikrofon testen"}</button>
      <div class="meter grow"><div style={{ width: `${(level ?? 0) * 100}%` }} /></div>
    </div>
  );
}

function Voice() {
  const s = settings.value;
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const cams = devices.filter((d) => d.kind === "videoinput");
  const [capturing, setCapturing] = useState(false);
  const v = voice.value;
  const set = (patch: Partial<Settings>) => {
    updateSettings(patch);
    if (v && ("inputDevice" in patch || "echoCancellation" in patch || "noiseSuppression" in patch || "autoGainControl" in patch)) void v.changeInputDevice();
    if (v && "outputDevice" in patch) v.refreshOutputs();
    if (v && "pushToTalk" in patch) v.applyMicEnabled();
  };
  useEffect(() => {
    if (!capturing) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      set({ pttKey: e.code });
      setCapturing(false);
    };
    window.addEventListener("keydown", k, { once: true });
    return () => window.removeEventListener("keydown", k);
  }, [capturing]);
  const label = (d: MediaDeviceInfo, i: number) => d.label || `Gerät ${i + 1}`;
  return (
    <>
      <h2>Sprache & Video</h2>
      {!devices.some((d) => d.label) && <div class="notice">Gerätenamen werden angezeigt, sobald der Mikrofonzugriff einmal erlaubt wurde (z. B. über „Mikrofon testen“).</div>}
      <div class="row" style={{ gap: "12px" }}>
        <Field label="Eingabegerät">
          <select class="select" value={s.inputDevice} onChange={(e) => set({ inputDevice: (e.target as HTMLSelectElement).value })}>
            <option value="">Standard</option>
            {inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
        </Field>
        <Field label="Ausgabegerät">
          <select class="select" value={s.outputDevice} onChange={(e) => set({ outputDevice: (e.target as HTMLSelectElement).value })}>
            <option value="">Standard</option>
            {outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
        </Field>
      </div>
      <MicTest />
      <div class="card col">
        <Toggle checked={s.echoCancellation} onChange={(x) => set({ echoCancellation: x })} label="Echounterdrückung" />
        <Toggle checked={s.noiseSuppression} onChange={(x) => set({ noiseSuppression: x })} label="Rauschunterdrückung" />
        <Toggle checked={s.autoGainControl} onChange={(x) => set({ autoGainControl: x })} label="Automatische Lautstärkeregelung" />
        <div class="faint xs">Verarbeitung durch die WebRTC-Audioengine (Opus-Codec). Änderungen gelten sofort, auch in laufenden Gesprächen.</div>
      </div>
      <div class="card col">
        <Toggle checked={s.pushToTalk} onChange={(x) => set({ pushToTalk: x })} label="Push-to-Talk" desc="Das Mikrofon sendet nur, solange die Taste gedrückt ist (wenn das NexusTalk-Fenster aktiv ist)." />
        {s.pushToTalk && (
          <div class="row">
            <span class="grow">Taste: <b class="mono">{s.pttKey}</b></span>
            <button class="btn sm" onClick={() => setCapturing(true)}>{capturing ? "Taste drücken …" : "Ändern"}</button>
          </div>
        )}
      </div>
      <Field label="Kamera">
        <select class="select" value={s.videoDevice} onChange={(e) => set({ videoDevice: (e.target as HTMLSelectElement).value })}>
          <option value="">Standard</option>
          {cams.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
        </select>
      </Field>
      <div class="faint xs">Kamera und Mikrofon werden nur aktiviert, während du in einem Sprachkanal bist bzw. die Kamera einschaltest.</div>
    </>
  );
}

function Screen() {
  const s = settings.value;
  const v = voice.value;
  const set = (patch: Partial<Settings>) => {
    updateSettings(patch);
    if (v?.sharingScreen.value) void v.applyScreenProfile();
  };
  const m = s.screenManual;
  return (
    <>
      <h2>Bildschirmübertragung</h2>
      <Field label="Qualitätsprofil">
        <div class="col" style={{ gap: "6px" }}>
          {(Object.entries(SCREEN_PROFILES) as [keyof typeof SCREEN_PROFILES, (typeof SCREEN_PROFILES)[keyof typeof SCREEN_PROFILES]][]).map(([k, p]) => (
            <label class="checkbox" key={k}>
              <input type="radio" name="prof" checked={s.screenProfile === k} onChange={() => set({ screenProfile: k })} />
              <span><b>{p.label}</b> <span class="faint small">bis {p.width}×{p.height}, {p.fps} FPS, max. {(p.kbps / 1000).toFixed(1)} Mbit/s</span></span>
            </label>
          ))}
          <label class="checkbox">
            <input type="radio" name="prof" checked={s.screenProfile === "manual"} onChange={() => set({ screenProfile: "manual" })} />
            <span><b>Manuell</b></span>
          </label>
        </div>
      </Field>
      {s.screenProfile === "manual" && (
        <div class="row" style={{ gap: "10px" }}>
          <Field label="Breite"><input class="input" type="number" min={320} max={3840} value={m.width} onChange={(e) => set({ screenManual: { ...m, width: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="Höhe"><input class="input" type="number" min={240} max={2160} value={m.height} onChange={(e) => set({ screenManual: { ...m, height: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="FPS"><input class="input" type="number" min={1} max={60} value={m.fps} onChange={(e) => set({ screenManual: { ...m, fps: Number((e.target as HTMLInputElement).value) } })} /></Field>
          <Field label="kbit/s"><input class="input" type="number" min={200} max={20000} value={m.kbps} onChange={(e) => set({ screenManual: { ...m, kbps: Number((e.target as HTMLInputElement).value) } })} /></Field>
        </div>
      )}
      <Toggle checked={s.screenAudio} onChange={(x) => set({ screenAudio: x })} label="Systemton mitübertragen" desc="Getrennt vom Mikrofon. Unter Windows meist nur bei „Gesamter Bildschirm“ verfügbar; NexusTalk zeigt an, wenn kein Ton übertragen wird." />
      <div class="notice">
        Beim Start wählst du im Systemdialog, was übertragen wird: einen ganzen Monitor oder ein einzelnes Fenster. Die Bitrate passt sich automatisch an die verfügbare Bandbreite an (WebRTC-Staukontrolle); die Werte oben sind Obergrenzen. Hardware-Encoder werden genutzt, sofern WebView2/Chromium sie für den Codec unterstützt.
      </div>
    </>
  );
}

function Notify() {
  const s = settings.value;
  return (
    <>
      <h2>Benachrichtigungen</h2>
      <div class="card col">
        <Toggle checked={s.notifications} onChange={(x) => updateSettings({ notifications: x })} label="Desktop-Benachrichtigungen" />
        <Toggle checked={s.notifyDMs} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyDMs: x })} label="Direktnachrichten" />
        <Toggle checked={s.notifyMentions} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyMentions: x })} label="Erwähnungen (@name)" />
        <Toggle checked={s.notifyAll} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyAll: x })} label="Alle Nachrichten in nicht stummgeschalteten Kanälen" />
        <Toggle checked={s.notifyVoiceJoin} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyVoiceJoin: x })} label="Eingehende Anrufe" />
      </div>
      <div class="faint small">Server und einzelne Kanäle lassen sich per Rechtsklick stummschalten. Im Status „Bitte nicht stören“ gibt es keine Benachrichtigungen.</div>
    </>
  );
}

function Look() {
  const s = settings.value;
  return (
    <>
      <h2>Darstellung</h2>
      <Field label="Design">
        <div class="tabs">
          {(["dark", "light", "system"] as const).map((t) => (
            <button key={t} class={s.theme === t ? "active" : ""} onClick={() => updateSettings({ theme: t })}>{{ dark: "Dunkel", light: "Hell", system: "Wie System" }[t]}</button>
          ))}
        </div>
      </Field>
      <Field label={`Schriftgröße (${Math.round(s.scale * 100)} %)`}>
        <input class="range" type="range" min={0.85} max={1.3} step={0.05} value={s.scale} onInput={(e) => updateSettings({ scale: Number((e.target as HTMLInputElement).value) })} />
      </Field>
      <Toggle checked={s.showMembers} onChange={(x) => updateSettings({ showMembers: x })} label="Mitgliederliste anzeigen" />
    </>
  );
}

function AppTab() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [auto, setAuto] = useState(false);
  useEffect(() => {
    void appInfo().then(setInfo);
    void autostart().then(setAuto).catch(() => {});
  }, []);
  return (
    <>
      <h2>App & Diagnose</h2>
      {isTauri && (
        <div class="card col">
          <Toggle
            checked={minimizeToTray.value}
            onChange={(x) => {
              minimizeToTray.value = x;
              void persistNow();
            }}
            label="Beim Schließen in den Infobereich minimieren"
            desc="Bei laufendem eigenem Server bleibt NexusTalk immer im Infobereich aktiv."
          />
          <Toggle
            checked={auto}
            onChange={async (x) => {
              try {
                setAuto(await autostart(x));
              } catch (e) {
                toast("Autostart nicht geändert", String(e), "error");
              }
            }}
            label="Mit Windows starten"
            desc="Startet NexusTalk minimiert im Infobereich."
          />
        </div>
      )}
      <div class="card">
        <div class="label" style={{ marginBottom: "8px" }}>Verbindungen</div>
        <table class="table">
          <tbody>
            {servers.value.map((s: ServerStore) => (
              <tr key={s.id}>
                <td>{s.displayName()}</td>
                <td class="mono xs">{s.saved.value.address}</td>
                <td>{s.conn.state.value === "ready" ? <span class="badge ok">verbunden</span> : <span class="badge warn">{s.conn.state.value}</span>}</td>
                <td class="xs">{s.conn.latency.value !== null ? `${s.conn.latency.value} ms` : ""}</td>
                <td><IconButton title="Neu verbinden" class="sm" onClick={() => s.conn.retryNow()}><Icon.Refresh /></IconButton></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="faint xs" style={{ marginTop: "6px" }}>Die Serververbindung (Text, Signalisierung) ist unabhängig von den direkten Medienverbindungen in Sprachkanälen; deren Qualität zeigt das Sprachpanel.</div>
      </div>
      {info && (
        <dl class="kv card">
          <dt>Version</dt><dd>{info.version}</dd>
          <dt>Daten</dt><dd class="mono xs selectable">{info.data_dir}</dd>
          <dt>Protokolle</dt><dd class="mono xs selectable">{info.log_dir}</dd>
        </dl>
      )}
      {info && (
        <div class="row">
          <button class="btn outline" onClick={() => void openFolder(info.log_dir)}><Icon.Folder /> Protokollordner öffnen</button>
          <button class="btn outline" onClick={() => void openFolder(info.data_dir)}><Icon.Folder /> Datenordner öffnen</button>
          <span class="spacer" />
          <button class="btn danger" onClick={() => void quitApp()}>NexusTalk beenden</button>
        </div>
      )}
    </>
  );
}

export function UserSettingsDialog({ tab: initial }: { tab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial ?? "account");
  const items: [Tab, string][] = [
    ["account", "Mein Konto"],
    ["voice", "Sprache & Video"],
    ["screen", "Bildschirmübertragung"],
    ["notify", "Benachrichtigungen"],
    ["look", "Darstellung"],
    ["app", "App & Diagnose"],
  ];
  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3>Einstellungen</h3>
        {items.map(([k, l]) => (
          <button key={k} class={tab === k ? "active" : ""} onClick={() => setTab(k)}>{l}</button>
        ))}
      </nav>
      <div class="pane-content" style={{ position: "relative" }}>
        <div class="pane-close"><IconButton title="Schließen (Esc)" onClick={closeModal}><Icon.X /></IconButton></div>
        {tab === "account" && <Account />}
        {tab === "voice" && <Voice />}
        {tab === "screen" && <Screen />}
        {tab === "notify" && <Notify />}
        {tab === "look" && <Look />}
        {tab === "app" && <AppTab />}
      </div>
    </Modal>
  );
}

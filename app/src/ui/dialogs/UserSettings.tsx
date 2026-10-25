// User settings: account (per server), audio/video, screen sharing,
// notifications, design & language, app & diagnostics, about.

import { useEffect, useRef, useState } from "preact/hooks";
import { activeServer, closeModal, minimizeToTray, openModal, persistNow, removeServer, servers, settings, toast, updateSettings, type Settings } from "../../state/app";
import type { ServerStore } from "../../state/server";
import { errorText, lang, LANGS, presenceText, t, type Key } from "../../i18n";
import { transport } from "../../net/transport";
import { appInfo, autostart, isTauri, openFolder, quitApp, type AppInfo } from "../../platform";
import { Avatar, Field, IconButton, Icon, LogoMark, Modal, Toggle, confirmDialog, promptDialog } from "../components";
import { pickAndCropImage } from "../ImageCrop";
import { voice } from "../../rtc/voice";
import { ScreenOptions } from "../ScreenShare";
import { THEMES } from "../../themes";
import { Flag } from "../flags";
import { DonateCard } from "./About";
import { ShortcutsDialog } from "../QuickSwitcher";
import { AUTHOR, COPYRIGHT, HOMEPAGE, PRODUCT_SITE } from "../../brand";
import { openExternal } from "../links";
import { play, playDemo, playBoard } from "../../sound";

type Tab = "account" | "voice" | "screen" | "notify" | "look" | "app" | "about";

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
  if (!server || !me) return <div class="muted">{t("settings.noServer")}</div>;

  const saveProfile = () => server.rpc("user.update", { display_name: display, status_text: status }).then(() => toast(t("settings.profileSaved"), undefined, "ok"), (e) => toast(t("common.error"), errorText(e), "error"));
  const setPresence = (p: string) => server.rpc("user.presence", { presence: p }).then(() => (server.me.value = { ...me, presence: p as never }), (e) => toast(t("common.error"), errorText(e), "error"));
  const avatar = async () => {
    const img = await pickAndCropImage({ round: true });
    if (!img) return;
    const r = await transport.upload(server.target(), "/api/v1/avatar", server.token, img).catch((e) => ({ status: 0, body: { error: e } }));
    if (r.status === 200) toast(t("settings.avatarUpdated"), undefined, "ok");
    else toast(t("common.uploadFailed"), errorText(r.body?.error), "error");
  };
  const changePw = async () => {
    try {
      await server.rpc("user.password", { old_password: oldPw, new_password: newPw });
      setOldPw("");
      setNewPw("");
      toast(t("settings.pwChanged"), t("settings.pwChangedBody"), "ok");
    } catch (e) {
      toast(t("settings.pwFailed"), errorText(e), "error");
    }
  };
  const logout = async () => {
    if (!(await confirmDialog({ title: t("settings.logoutTitle"), body: t("settings.logoutBody", { name: server.displayName() }), confirm: t("settings.logout") }))) return;
    await transport.http(server.target(), "POST", "/api/v1/auth/logout", server.token).catch(() => {});
    removeServer(server.id);
    closeModal();
  };
  const deleteAccount = async () => {
    const pw = await promptDialog({ title: t("settings.deleteTitle"), body: t("settings.deleteBody", { name: server.displayName() }), label: t("settings.deletePw"), password: true, confirm: t("common.next"), danger: true });
    if (!pw) return;
    const withMsgs = await confirmDialog({ title: t("settings.deleteMsgsTitle"), body: t("settings.deleteMsgsBody"), confirm: t("settings.deleteMsgs") });
    try {
      await server.rpc("user.delete_account", { password: pw, delete_messages: withMsgs });
      removeServer(server.id);
      closeModal();
      toast(t("settings.deleted"), undefined, "ok");
    } catch (e) {
      toast(t("common.deleteFailed"), errorText(e), "error");
    }
  };

  return (
    <>
      <h2>{t("settings.account")}</h2>
      {servers.value.length > 1 && (
        <Field label={t("settings.server")} hint={t("settings.perServer")}>
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
          <div style={{ fontWeight: 650, fontSize: "var(--fs-lg)" }}>{me.display_name || me.username}</div>
          <div class="faint selectable">@{me.username}</div>
        </div>
        <button class="btn outline" onClick={() => void avatar()}>{t("settings.changeAvatar")}</button>
        {me.avatar && <button class="btn ghost" onClick={() => transport.http(server.target(), "DELETE", "/api/v1/avatar", server.token)}>{t("common.remove")}</button>}
      </div>
      <Field label={t("settings.presence")}>
        <div class="tabs">
          {["online", "idle", "dnd", "invisible"].map((p) => (
            <button key={p} class={(me.presence ?? "online") === p ? "active" : ""} onClick={() => void setPresence(p)}>{presenceText(p)}</button>
          ))}
        </div>
      </Field>
      <div class="row wrap" style={{ gap: "12px", alignItems: "flex-end" }}>
        <Field label={t("settings.displayName")}><input class="input" maxLength={32} value={display} onInput={(e) => setDisplay((e.target as HTMLInputElement).value)} /></Field>
        <Field label={t("settings.statusText")}><input class="input" maxLength={128} value={status} onInput={(e) => setStatus((e.target as HTMLInputElement).value)} /></Field>
        <button class="btn primary" onClick={() => void saveProfile()}>{t("common.save")}</button>
      </div>
      <div class="card col">
        <div class="label">{t("settings.changePw")}</div>
        <div class="row wrap" style={{ gap: "10px" }}>
          <input class="input grow" type="password" placeholder={t("settings.currentPw")} autoComplete="current-password" value={oldPw} onInput={(e) => setOldPw((e.target as HTMLInputElement).value)} />
          <input class="input grow" type="password" placeholder={t("settings.newPw")} autoComplete="new-password" value={newPw} onInput={(e) => setNewPw((e.target as HTMLInputElement).value)} />
          <button class="btn" disabled={!oldPw || newPw.length < 8} onClick={() => void changePw()}>{t("common.change")}</button>
        </div>
      </div>
      <div class="row">
        <button class="btn outline" onClick={() => void logout()}><Icon.Logout class="icon flip" /> {t("settings.logout")}</button>
        <span class="spacer" />
        <button class="btn ghost" style={{ color: "var(--danger)" }} onClick={() => void deleteAccount()}>{t("settings.deleteAccount")}</button>
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
      const timer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (const v of buf) s += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
      }, 80);
      stop.current = () => {
        clearInterval(timer);
        stream.getTracks().forEach((x) => x.stop());
        void ctx.close();
      };
    } catch (e) {
      toast(t("settings.micTestFailed"), String(e), "error");
    }
  };
  return (
    <div class="row">
      <button class="btn" onClick={() => void toggle()}>{stop.current ? t("settings.stopTest") : t("settings.micTest")}</button>
      <div class="meter grow"><div style={{ width: `${(level ?? 0) * 100}%` }} /></div>
    </div>
  );
}

function KeyCapture({ value, onChange, allowAll }: { value: string; onChange: (k: string) => void; allowAll: boolean }) {
  const [capturing, setCapturing] = useState(false);
  useEffect(() => {
    if (!capturing) return;
    const k = (e: KeyboardEvent) => {
      e.preventDefault();
      // Global shortcuts use accelerator names (F8, Pause, …); in-window keys use KeyboardEvent.code.
      onChange(allowAll ? e.code : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      setCapturing(false);
    };
    window.addEventListener("keydown", k, { once: true });
    return () => window.removeEventListener("keydown", k);
  }, [capturing]);
  return (
    <div class="row">
      <span class="grow">{t("settings.key")}: <kbd>{value.replace(/^Key/, "")}</kbd></span>
      <button class="btn sm" onClick={() => setCapturing(true)}>{capturing ? t("settings.pressKey") : t("common.change")}</button>
    </div>
  );
}

function Voice() {
  const s = settings.value;
  const devices = useDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const cams = devices.filter((d) => d.kind === "videoinput");
  const v = voice.value;
  const set = (patch: Partial<Settings>) => {
    updateSettings(patch);
    if (v && ("inputDevice" in patch || "echoCancellation" in patch || "noiseSuppression" in patch || "autoGainControl" in patch)) void v.changeInputDevice();
    if (v && "outputDevice" in patch) v.refreshOutputs();
    if (v && ("pushToTalk" in patch || "globalPtt" in patch || "globalPttKey" in patch)) {
      v.applyMicEnabled();
      void v.registerGlobalPtt();
    }
  };
  const label = (d: MediaDeviceInfo, i: number) => d.label || t("settings.deviceN", { n: i + 1 });
  return (
    <>
      <h2>{t("settings.voice")}</h2>
      {!devices.some((d) => d.label) && <div class="notice">{t("settings.deviceNamesHint")}</div>}
      <div class="row wrap" style={{ gap: "12px" }}>
        <Field label={t("settings.input")}>
          <select class="select" value={s.inputDevice} onChange={(e) => set({ inputDevice: (e.target as HTMLSelectElement).value })}>
            <option value="">{t("common.default")}</option>
            {inputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
        </Field>
        <Field label={t("settings.output")}>
          <select class="select" value={s.outputDevice} onChange={(e) => set({ outputDevice: (e.target as HTMLSelectElement).value })}>
            <option value="">{t("common.default")}</option>
            {outputs.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
          </select>
        </Field>
      </div>
      <MicTest />
      <div class="card col">
        <Toggle checked={s.echoCancellation} onChange={(x) => set({ echoCancellation: x })} label={t("settings.echo")} />
        <Toggle checked={s.noiseSuppression} onChange={(x) => set({ noiseSuppression: x })} label={t("settings.noise")} />
        <Toggle checked={s.autoGainControl} onChange={(x) => set({ autoGainControl: x })} label={t("settings.agc")} />
        <div class="faint xs">{t("settings.audioHint")}</div>
      </div>
      <div class="card col">
        <Toggle checked={s.pushToTalk} onChange={(x) => set({ pushToTalk: x })} label={t("settings.ptt")} desc={t("settings.pttDesc")} />
        {s.pushToTalk && <KeyCapture value={s.pttKey} allowAll onChange={(k) => set({ pttKey: k })} />}
        {s.pushToTalk && isTauri && (
          <>
            <Toggle checked={s.globalPtt} onChange={(x) => set({ globalPtt: x })} label={t("settings.globalPtt")} desc={t("settings.globalPttDesc")} />
            {s.globalPtt && <KeyCapture value={s.globalPttKey} allowAll={false} onChange={(k) => set({ globalPttKey: k })} />}
          </>
        )}
      </div>
      <Field label={t("settings.camera")}>
        <select class="select" value={s.videoDevice} onChange={(e) => set({ videoDevice: (e.target as HTMLSelectElement).value })}>
          <option value="">{t("common.default")}</option>
          {cams.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{label(d, i)}</option>)}
        </select>
      </Field>
      <div class="faint xs">{t("settings.privacyHint")}</div>
    </>
  );
}

function Screen() {
  const v = voice.value;
  return (
    <>
      <h2>{t("screen.title")}</h2>
      <div class="col" style={{ gap: "12px", maxWidth: "460px" }}>
        <ScreenOptions viewers={v ? v.peerIds().length : undefined} />
        {v?.sharingScreen.value && <button class="btn primary" onClick={() => void v.applyScreenProfile()}>{t("sc.apply")}</button>}
      </div>
      <div class="notice">{t("screen.notice")}</div>
    </>
  );
}

function Notify() {
  const s = settings.value;
  return (
    <>
      <h2>{t("settings.notifications")}</h2>
      <div class="card col">
        <Toggle checked={s.notifications} onChange={(x) => updateSettings({ notifications: x })} label={t("settings.desktopNotify")} />
        <Toggle checked={s.notifyDMs} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyDMs: x })} label={t("settings.notifyDms")} />
        <Toggle checked={s.notifyMentions} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyMentions: x })} label={t("settings.notifyMentions")} />
        <Toggle checked={s.notifyAll} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyAll: x })} label={t("settings.notifyAll")} />
        <Toggle checked={s.notifyVoiceJoin} disabled={!s.notifications} onChange={(x) => updateSettings({ notifyVoiceJoin: x })} label={t("settings.notifyCalls")} />
        <div class="row">
          <div class="grow">
            <Toggle checked={s.notifySound} disabled={!s.notifications} onChange={(x) => updateSettings({ notifySound: x })} label={t("settings.sound")} />
          </div>
          <button class="btn sm ghost" onClick={() => play("message", true)}>▶ {t("settings.test")}</button>
        </div>
      </div>
      <div class="card col">
        <div class="row">
          <div class="grow">
            <Toggle checked={s.uiSounds} onChange={(x) => updateSettings({ uiSounds: x })} label={t("snd.ui")} desc={t("snd.uiDesc")} />
          </div>
          <button class="btn sm ghost" onClick={() => playDemo()}>▶ {t("snd.demo")}</button>
        </div>
        <div class="row" style={{ gap: "10px", opacity: s.uiSounds ? 1 : 0.5 }}>
          <span class="label" style={{ margin: "0px", minWidth: "80px" }}>{t("snd.volume")}</span>
          <input class="range grow" type="range" min={0.1} max={1} step={0.05} value={s.uiVolume} disabled={!s.uiSounds} onChange={(e) => { updateSettings({ uiVolume: Number((e.target as HTMLInputElement).value) }); play("join", true); }} />
        </div>
      </div>
      <div class="card col">
        <Toggle checked={s.soundboard} onChange={(x) => updateSettings({ soundboard: x })} label={t("board.setting")} desc={t("board.settingDesc")} />
        <div class="row" style={{ gap: "10px", opacity: s.soundboard ? 1 : 0.5 }}>
          <span class="label" style={{ margin: "0px", minWidth: "80px" }}>{t("snd.volume")}</span>
          <input class="range grow" type="range" min={0.05} max={1} step={0.05} value={s.soundboardVolume} disabled={!s.soundboard} onChange={(e) => { const v = Number((e.target as HTMLInputElement).value); updateSettings({ soundboardVolume: v }); playBoard("bell", v); }} />
        </div>
      </div>
      <div class="card col">
        <Toggle checked={s.autoAway} onChange={(x) => updateSettings({ autoAway: x })} label={t("settings.autoAway")} desc={t("settings.autoAwayDesc", { n: s.autoAwayMinutes })} />
        {s.autoAway && (
          <Field label={t("settings.autoAwayMinutes")}>
            <input class="input" type="number" min={1} max={120} value={s.autoAwayMinutes} style={{ width: "100px" }} onChange={(e) => updateSettings({ autoAwayMinutes: Math.max(1, Number((e.target as HTMLInputElement).value) || 10) })} />
          </Field>
        )}
      </div>
      <div class="faint small">{t("settings.notifyHint")}</div>
    </>
  );
}

function Look() {
  const s = settings.value;
  return (
    <>
      <h2>{t("settings.look")}</h2>
      <Field label={t("settings.design")}>
        <div class="theme-grid">
          {THEMES.map((th) => (
            <button key={th.id} class={`theme-card${s.theme === th.id && !s.followSystemTheme ? " active" : ""}`} onClick={() => updateSettings({ theme: th.id, followSystemTheme: false })}>
              <div class="preview" style={{ background: th.preview }}>
                <i style={{ width: "14%" }} />
                <i style={{ width: "26%", margin: "6px 0 6px 0", borderRadius: "6px 0 0 6px", background: th.light ? "#ffffff80" : "#00000055" }} />
                <i style={{ flex: 1, margin: "6px 6px 6px 0", borderRadius: "0 6px 6px 0", background: th.light ? "#ffffffb0" : "#00000033", position: "relative" }}>
                  <b style={{ position: "absolute", left: "12%", top: "22%", width: "54%", height: "9px", borderRadius: "5px", background: th.swatch[3], boxShadow: `0 0 12px ${th.swatch[3]}88` }} />
                  <b style={{ position: "absolute", left: "12%", top: "48%", width: "70%", height: "6px", borderRadius: "4px", background: th.light ? "#0002" : "#fff2" }} />
                  <b style={{ position: "absolute", left: "12%", top: "66%", width: "42%", height: "6px", borderRadius: "4px", background: th.swatch[4], opacity: 0.8 }} />
                </i>
              </div>
              <div class="name">{t(`theme.${th.id}` as Key)}</div>
            </button>
          ))}
        </div>
      </Field>
      <Toggle checked={s.followSystemTheme} onChange={(x) => updateSettings({ followSystemTheme: x })} label={t("settings.followSystem")} desc={t("settings.followSystemDesc")} />
      <Field label={t("lang.title")}>
        <div class="flag-picker" style={{ width: "auto", padding: "0px" }}>
          {LANGS.map((l) => (
            <button key={l.code} class={lang.value === l.code ? "active" : ""} onClick={() => updateSettings({ language: l.code })}>
              <Flag code={l.flag} />
              <span dir={l.rtl ? "rtl" : "ltr"}>{l.name}</span>
            </button>
          ))}
        </div>
      </Field>
      <Toggle checked={!s.language} onChange={(x) => updateSettings({ language: x ? "" : lang.value })} label={t("lang.system")} />
      <Field label={t("settings.scale", { n: Math.round(s.scale * 100) })}>
        <input class="range" type="range" min={0.85} max={1.3} step={0.05} value={s.scale} onInput={(e) => updateSettings({ scale: Number((e.target as HTMLInputElement).value) })} />
      </Field>
      <Toggle checked={s.showMembers} onChange={(x) => updateSettings({ showMembers: x })} label={t("chat.showMembers")} />
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
      <h2>{t("settings.app")}</h2>
      {isTauri && (
        <div class="card col">
          <Toggle
            checked={minimizeToTray.value}
            onChange={(x) => {
              minimizeToTray.value = x;
              void persistNow();
            }}
            label={t("settings.tray")}
            desc={t("settings.trayDesc")}
          />
          <Toggle
            checked={auto}
            onChange={async (x) => {
              try {
                setAuto(await autostart(x));
              } catch (e) {
                toast(t("settings.autostartFailed"), String(e), "error");
              }
            }}
            label={t("settings.autostart")}
            desc={t("settings.autostartDesc")}
          />
        </div>
      )}
      <div class="card">
        <div class="label" style={{ marginBottom: "8px" }}>{t("settings.connections")}</div>
        <table class="table">
          <tbody>
            {servers.value.map((s: ServerStore) => (
              <tr key={s.id}>
                <td>{s.displayName()}</td>
                <td class="mono xs">{s.saved.value.address}</td>
                <td>{s.conn.state.value === "ready" ? <span class="badge ok">{t("conn.connected")}</span> : <span class="badge warn">{s.conn.state.value}</span>}</td>
                <td class="xs">{s.conn.latency.value !== null ? `${s.conn.latency.value} ms` : ""}</td>
                <td><IconButton title={t("rail.reconnect")} class="sm" onClick={() => s.conn.retryNow()}><Icon.Refresh /></IconButton></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div class="faint xs" style={{ marginTop: "6px" }}>{t("settings.connectionsHint")}</div>
      </div>
      <button class="btn outline" style={{ alignSelf: "flex-start" }} onClick={() => openModal(<ShortcutsDialog />)}><Icon.Keyboard /> {t("keys.title")}</button>
      {info && (
        <dl class="kv card">
          <dt>{t("srv.version")}</dt><dd>{info.version}</dd>
          <dt>{t("settings.data")}</dt><dd class="mono xs selectable">{info.data_dir}</dd>
          <dt>{t("settings.logs")}</dt><dd class="mono xs selectable">{info.log_dir}</dd>
        </dl>
      )}
      {info && (
        <div class="row wrap">
          <button class="btn outline" onClick={() => void openFolder(info.log_dir)}><Icon.Folder /> {t("settings.openLogs")}</button>
          <button class="btn outline" onClick={() => void openFolder(info.data_dir)}><Icon.Folder /> {t("settings.openData")}</button>
          <span class="spacer" />
          <button class="btn danger" onClick={() => void quitApp()}>{t("settings.quit")}</button>
        </div>
      )}
    </>
  );
}

function About() {
  return (
    <>
      <div class="about-hero">
        <LogoMark />
        <div>
          <h2 style={{ fontSize: "var(--fs-2xl)" }}>NexusTalk</h2>
          <div class="muted">{t("about.tagline")}</div>
        </div>
      </div>
      <dl class="kv card">
        <dt>{t("about.author")}</dt><dd>{AUTHOR}</dd>
        <dt>{t("about.homepage")}</dt><dd><a href={HOMEPAGE} onClick={(e) => { e.preventDefault(); void openExternal(HOMEPAGE, true); }}>{HOMEPAGE.replace("https://", "")}</a></dd>
        <dt>{t("about.website")}</dt><dd><a href={PRODUCT_SITE} onClick={(e) => { e.preventDefault(); void openExternal(PRODUCT_SITE, true); }}>{PRODUCT_SITE.replace("https://", "")}</a></dd>
        <dt>{t("about.license")}</dt><dd>MIT</dd>
      </dl>
      <DonateCard />
      <div class="credit">{COPYRIGHT} · {t("about.rights")}</div>
    </>
  );
}

export function UserSettingsDialog({ tab: initial }: { tab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initial ?? "account");
  const items: [Tab, string, preact.ComponentChild][] = [
    ["account", t("settings.account"), <Icon.Users />],
    ["voice", t("settings.voice"), <Icon.Mic />],
    ["screen", t("screen.title"), <Icon.Screen />],
    ["notify", t("settings.notifications"), <Icon.Bell />],
    ["look", t("settings.look"), <Icon.Palette />],
    ["app", t("settings.app"), <Icon.Gear />],
    ["about", t("about.title"), <Icon.Heart />],
  ];
  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3>{t("settings.title")}</h3>
        {items.map(([k, l, ic]) => (
          <button key={k} class={tab === k ? "active" : ""} onClick={() => setTab(k)}>{ic}{l}</button>
        ))}
      </nav>
      <div class="pane-content">
        <div class="pane-close"><IconButton title={t("common.closeEsc")} onClick={closeModal}><Icon.X /></IconButton></div>
        {tab === "account" && <Account />}
        {tab === "voice" && <Voice />}
        {tab === "screen" && <Screen />}
        {tab === "notify" && <Notify />}
        {tab === "look" && <Look />}
        {tab === "app" && <AppTab />}
        {tab === "about" && <About />}
      </div>
    </Modal>
  );
}

// "Run your own server": configure, start and stop the embedded server.
// Exposure to the network is an explicit, confirmed step.

import { useEffect, useState } from "preact/hooks";
import { addServer, closeModal, hostAutostart, persistNow, servers, toast } from "../../state/app";
import { errorText, t } from "../../i18n";
import { transport } from "../../net/transport";
import { isTauri, tauriInvoke } from "../../platform";
import { Field, IconButton, Icon, Modal, Spinner, Toggle, confirmDialog, copyText } from "../components";
import { deviceName } from "./AddServer";

interface HostStatus {
  running: boolean;
  address: string | null;
  fingerprint: string | null;
  setup_code: string | null;
  error: string | null;
  data_dir: string;
  exposed: boolean;
  lan_ip: string | null;
}

interface Config {
  bind: string;
  port: number;
  public_host: string;
  tls: { enabled: boolean; cert_path: string; key_path: string };
  media: {
    stun_enabled: boolean;
    turn_enabled: boolean;
    udp_port: number;
    relay_ip: string;
    relay_port_min: number;
    relay_port_max: number;
    ice_servers: unknown[];
    max_voice_participants: number;
  };
  limits: Record<string, number>;
  log: { level: string; max_files: number };
}

function localAddress(cfg: Config) {
  return `${cfg.tls.enabled ? "https" : "http"}://127.0.0.1:${cfg.port}`;
}

function OwnerSetup({ status, cfg, onDone }: { status: HostStatus; cfg: Config; onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = { address: localAddress(cfg), fingerprint: status.fingerprint };
      const r = await transport.http(target, "POST", "/api/v1/auth/register", null, { username, password, invite: status.setup_code, device: deviceName() });
      if (r.status !== 200) throw r.body?.error ?? { code: "INTERNAL", msg: `HTTP ${r.status}` };
      addServer({ id: crypto.randomUUID(), address: target.address, fingerprint: status.fingerprint, name: t("host.myServer"), username: r.body.user.username, token: r.body.token, hosted: true });
      await tauriInvoke("host_setup_done");
      toast(t("host.setupDone"), t("host.setupDoneBody"), "ok");
      onDone();
      closeModal();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card col">
      <div class="label">{t("host.ownerTitle")}</div>
      <div class="small muted">{t("host.ownerText")}</div>
      <div class="row wrap" style={{ gap: "10px" }}>
        <input class="input grow" placeholder={t("add.username")} autoComplete="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        <input class="input grow" type="password" placeholder={t("host.pwPlaceholder")} autoComplete="new-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        <button class="btn primary" disabled={busy || !username || password.length < 8} onClick={() => void create()}>{busy ? <Spinner /> : t("host.create")}</button>
      </div>
      {error && <div class="error-text">{error}</div>}
      <div class="faint xs">{t("host.setupCode")} <span class="mono selectable">{status.setup_code}</span></div>
    </div>
  );
}

function ExposureWarning({ cfg }: { cfg: Config }) {
  return (
    <div class="col" style={{ gap: "8px" }}>
      <div>{t("host.exposeText")}</div>
      <div>{t("host.portsNeeded")}</div>
      <ul style={{ margin: "0px", paddingInlineStart: "18px" }}>
        <li><b>TCP {cfg.port}</b> – {t("host.portTcp")}</li>
        {(cfg.media.stun_enabled || cfg.media.turn_enabled) && <li><b>UDP {cfg.media.udp_port}</b> – {cfg.media.turn_enabled ? t("host.portStunTurn") : t("host.portStun")}</li>}
        {cfg.media.turn_enabled && <li><b>UDP {cfg.media.relay_port_min}–{cfg.media.relay_port_max}</b> – {t("host.portRelay")}</li>}
      </ul>
      <div>{t("host.firewallText")}</div>
    </div>
  );
}

export function HostDialog() {
  const [status, setStatus] = useState<HostStatus | null>(null);
  const [cfg, setCfg] = useState<Config | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);

  const refresh = async () => {
    setStatus(await tauriInvoke<HostStatus>("host_status"));
    try {
      setCfg(await tauriInvoke<Config>("host_config"));
      setCfgError(null);
    } catch (e) {
      setCfgError(String(e));
    }
  };
  useEffect(() => {
    if (isTauri) void refresh();
  }, []);

  if (!isTauri) {
    return (
      <Modal title={t("rail.host")} footer={<button class="btn" onClick={closeModal}>{t("common.close")}</button>}>
        <div class="muted">{t("host.browserOnly")}</div>
      </Modal>
    );
  }
  if (!status) return <Modal title={t("rail.host")}><Spinner /></Modal>;

  const set = (patch: (c: Config) => Config) => {
    setCfg((c) => (c ? patch(structuredClone(c)) : c));
    setDirty(true);
  };

  const save = async (): Promise<boolean> => {
    if (!cfg) return false;
    try {
      await tauriInvoke("host_config_save", { config: { ...cfg, port: Number(cfg.port) } });
      setDirty(false);
      if (status.running) setNeedsRestart(true);
      toast(t("host.configSaved"), undefined, "ok");
      return true;
    } catch (e) {
      toast(t("common.saveFailed"), String(e), "error");
      return false;
    }
  };

  const run = async (cmd: "host_start" | "host_stop" | "host_restart") => {
    if (dirty && cmd !== "host_stop" && !(await save())) return;
    setBusy(true);
    try {
      setStatus(await tauriInvoke<HostStatus>(cmd));
      setNeedsRestart(false);
      if (cmd !== "host_stop") servers.value.filter((s) => s.saved.value.hosted).forEach((s) => setTimeout(() => s.conn.retryNow(), 300));
    } catch (e) {
      toast(t("host.startFailed"), String(e), "error");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setExposure = async (exposed: boolean) => {
    if (!cfg) return;
    if (exposed && !(await confirmDialog({ title: t("host.exposeTitle"), body: <ExposureWarning cfg={cfg} />, confirm: t("host.exposeConfirm"), danger: true }))) return;
    set((c) => ({ ...c, bind: exposed ? "0.0.0.0" : "127.0.0.1", public_host: exposed && !c.public_host ? (status.lan_ip ?? "") : c.public_host }));
  };

  const hostedEntry = servers.value.find((s) => s.saved.value.hosted);
  const exposed = cfg ? cfg.bind !== "127.0.0.1" && cfg.bind !== "::1" : false;

  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3>{t("host.mode")}</h3>
        <div style={{ padding: "6px 10px" }} class="col">
          {status.running ? <span class="badge ok">● {t("host.running")}</span> : <span class="badge">○ {t("host.stopped")}</span>}
          {status.address && <span class="mono xs">{status.address}</span>}
          {status.running && (status.exposed ? <span class="badge warn">{t("srv.exposed")}</span> : <span class="badge ok">{t("host.thisPcOnly")}</span>)}
        </div>
        <div class="col" style={{ padding: "10px" }}>
          {!status.running ? (
            <button class="btn primary block" disabled={busy || !cfg} onClick={() => void run("host_start")}>{busy ? <Spinner /> : t("host.start")}</button>
          ) : (
            <>
              <button class="btn block" disabled={busy} onClick={() => void run("host_restart")}>{t("host.restart")}</button>
              <button
                class="btn danger block"
                disabled={busy}
                onClick={async () => {
                  if (await confirmDialog({ title: t("host.stopTitle"), body: t("host.stopBody"), confirm: t("host.stop"), danger: true })) void run("host_stop");
                }}
              >
                {t("host.stop")}
              </button>
            </>
          )}
        </div>
      </nav>
      <div class="pane-content">
        <div class="pane-close"><IconButton title={t("common.closeEsc")} onClick={closeModal}><Icon.X /></IconButton></div>
        <h2>{t("rail.host")}</h2>
        <div class="faint small">{t("host.intro")} <span class="mono selectable">{status.data_dir}</span></div>
        {status.error && <div class="notice danger">{status.error}</div>}
        {cfgError && (
          <div class="notice danger col">
            <div>{t("host.configBroken", { detail: cfgError })}</div>
            <button
              class="btn sm"
              onClick={async () => {
                await tauriInvoke("host_config_reset");
                await refresh();
                toast(t("host.configReset"), t("host.configResetBody"), "info");
              }}
            >
              {t("host.resetConfig")}
            </button>
          </div>
        )}
        {needsRestart && (
          <div class="notice warn row">
            <span class="grow">{t("host.needsRestart")}</span>
            <button class="btn sm" onClick={() => void run("host_restart")}>{t("host.restartNow")}</button>
          </div>
        )}
        {status.running && status.setup_code && cfg && <OwnerSetup status={status} cfg={cfg} onDone={() => void refresh()} />}
        {status.running && !status.setup_code && !hostedEntry && cfg && <div class="notice">{t("host.alreadySetup", { address: localAddress(cfg) })}</div>}
        {status.running && status.fingerprint && (
          <div class="card row">
            <div class="grow" style={{ minWidth: "0px" }}>
              <div class="label">{t("cert.fingerprint")}</div>
              <div class="mono xs selectable" style={{ wordBreak: "break-all" }}>{status.fingerprint}</div>
            </div>
            <IconButton title={t("common.copy")} onClick={() => copyText(status.fingerprint!)}><Icon.Copy /></IconButton>
          </div>
        )}
        {cfg && (
          <>
            <div class="card col">
              <div class="label">{t("host.reach")}</div>
              <label class="checkbox">
                <input type="radio" name="exp" checked={!exposed} onChange={() => void setExposure(false)} />
                <span><b>{t("host.thisPcOnly")}</b> <span class="faint small">{t("host.thisPcHint")}</span></span>
              </label>
              <label class="checkbox">
                <input type="radio" name="exp" checked={exposed} onChange={() => void setExposure(true)} />
                <span><b>{t("host.lanInternet")}</b> <span class="faint small">{t("host.lanHint")}</span></span>
              </label>
              <div class="row wrap" style={{ gap: "10px" }}>
                <Field label={t("host.tcpPort")}>
                  <input class="input" type="number" min={1} max={65535} value={cfg.port} onInput={(e) => set((c) => ({ ...c, port: Number((e.target as HTMLInputElement).value) }))} />
                </Field>
                <Field label={t("host.publicAddress")} hint={status.lan_ip ? t("host.lanIp", { ip: status.lan_ip }) : undefined}>
                  <input class="input" placeholder={t("host.publicPlaceholder")} value={cfg.public_host} onInput={(e) => set((c) => ({ ...c, public_host: (e.target as HTMLInputElement).value.trim() }))} />
                </Field>
              </div>
              {exposed && <div class="notice warn small"><ExposureWarning cfg={cfg} /></div>}
            </div>
            <div class="card col">
              <div class="label">{t("host.security")}</div>
              <Toggle checked={cfg.tls.enabled} onChange={(x) => set((c) => ({ ...c, tls: { ...c.tls, enabled: x } }))} label={t("host.tls")} desc={t("host.tlsDesc")} />
              {cfg.tls.enabled && (
                <div class="row wrap" style={{ gap: "10px" }}>
                  <Field label={t("host.certPath")}><input class="input" value={cfg.tls.cert_path} placeholder="C:\…\fullchain.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, cert_path: (e.target as HTMLInputElement).value } }))} /></Field>
                  <Field label={t("host.keyPath")}><input class="input" value={cfg.tls.key_path} placeholder="C:\…\privkey.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, key_path: (e.target as HTMLInputElement).value } }))} /></Field>
                </div>
              )}
              {!cfg.tls.enabled && <div class="notice danger small">{t("host.noTlsWarn")}</div>}
            </div>
            <div class="card col">
              <div class="label">{t("host.media")}</div>
              <Toggle checked={cfg.media.stun_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, stun_enabled: x } }))} label={t("host.stun")} desc={t("host.stunDesc")} />
              <Toggle checked={cfg.media.turn_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, turn_enabled: x } }))} label={t("host.turn")} desc={t("host.turnDesc")} />
              <div class="row wrap" style={{ gap: "10px" }}>
                <Field label={t("host.udpPort")}><input class="input" type="number" value={cfg.media.udp_port} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, udp_port: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                <Field label={t("host.maxVoice")}><input class="input" type="number" min={1} max={50} value={cfg.media.max_voice_participants} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, max_voice_participants: Number((e.target as HTMLInputElement).value) } }))} /></Field>
              </div>
              {cfg.media.turn_enabled && (
                <div class="row wrap" style={{ gap: "10px" }}>
                  <Field label={t("host.relayIp")}><input class="input" value={cfg.media.relay_ip} placeholder={status.lan_ip ?? ""} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_ip: (e.target as HTMLInputElement).value.trim() } }))} /></Field>
                  <Field label={t("host.relayFrom")}><input class="input" type="number" value={cfg.media.relay_port_min} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_min: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                  <Field label={t("host.relayTo")}><input class="input" type="number" value={cfg.media.relay_port_max} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_max: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                </div>
              )}
              <div class="faint xs">{t("host.meshHint")}</div>
            </div>
            <div class="card col">
              <Toggle
                checked={hostAutostart.value}
                onChange={(x) => {
                  hostAutostart.value = x;
                  void persistNow();
                }}
                label={t("host.autostart")}
                desc={t("host.autostartDesc")}
              />
            </div>
            <div class="row">
              <button class="btn primary" disabled={!dirty} onClick={() => void save()}>{t("host.saveConfig")}</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

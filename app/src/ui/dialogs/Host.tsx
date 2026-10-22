// "Eigenen Server betreiben": configure, start and stop the embedded server.
// Exposure to the network is an explicit, confirmed step.

import { useEffect, useState } from "preact/hooks";
import { addServer, closeModal, hostAutostart, persistNow, servers, toast } from "../../state/app";
import { errorText } from "../../i18n";
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
      addServer({ id: crypto.randomUUID(), address: target.address, fingerprint: status.fingerprint, name: "Mein Server", username: r.body.user.username, token: r.body.token, hosted: true });
      await tauriInvoke("host_setup_done");
      toast("Server eingerichtet", "Du bist als Serverinhaber angemeldet.", "ok");
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
      <div class="label">Serverinhaber anlegen</div>
      <div class="small muted">Der Server läuft. Lege jetzt dein Inhaberkonto an – es hat alle Rechte und kann Einladungen erstellen.</div>
      <div class="row" style={{ gap: "10px" }}>
        <input class="input" placeholder="Benutzername" autoComplete="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        <input class="input" type="password" placeholder="Passwort (min. 8 Zeichen)" autoComplete="new-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        <button class="btn primary" disabled={busy || !username || password.length < 8} onClick={() => void create()}>{busy ? <Spinner /> : "Anlegen"}</button>
      </div>
      {error && <div class="error-text">{error}</div>}
      <div class="faint xs">Einrichtungscode (einmalig gültig, auch in setup-code.txt im Serverordner): <span class="mono selectable">{status.setup_code}</span></div>
    </div>
  );
}

const exposureWarning = (cfg: Config) => (
  <div class="col" style={{ gap: "8px" }}>
    <div>Der Server wird dann für <b>alle Geräte im lokalen Netzwerk</b> erreichbar – und, falls dein Router Ports weiterleitet, auch aus dem Internet.</div>
    <div>Benötigte Ports:</div>
    <ul style={{ margin: "0px", paddingLeft: "18px" }}>
      <li><b>TCP {cfg.port}</b> – Anmeldung, Text, Signalisierung (verschlüsselt mit TLS)</li>
      {(cfg.media.stun_enabled || cfg.media.turn_enabled) && <li><b>UDP {cfg.media.udp_port}</b> – STUN{cfg.media.turn_enabled ? "/TURN" : ""} für Sprach- und Bildverbindungen</li>}
      {cfg.media.turn_enabled && <li><b>UDP {cfg.media.relay_port_min}–{cfg.media.relay_port_max}</b> – TURN-Relay</li>}
    </ul>
    <div>Windows fragt beim ersten Start nach einer Firewall-Freigabe. Für Zugriff aus dem Internet muss dein Router diese Ports an diesen PC weiterleiten. Lass die Registrierung auf „Nur mit Einladung“, solange du nicht weißt, wer den Server erreichen kann.</div>
  </div>
);

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
      <Modal title="Eigenen Server betreiben" footer={<button class="btn" onClick={closeModal}>Schließen</button>}>
        <div class="muted">Der integrierte Servermodus ist in der Desktop-App verfügbar. Alternativ kann der eigenständige Server <span class="mono">nexustalk-server</span> auf Windows oder Linux ohne Oberfläche betrieben werden (siehe Dokumentation).</div>
      </Modal>
    );
  }
  if (!status) return <Modal title="Eigenen Server betreiben"><Spinner /></Modal>;

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
      toast("Serverkonfiguration gespeichert", undefined, "ok");
      return true;
    } catch (e) {
      toast("Speichern fehlgeschlagen", String(e), "error");
      return false;
    }
  };

  const run = async (cmd: "host_start" | "host_stop" | "host_restart") => {
    if (dirty && cmd !== "host_stop" && !(await save())) return;
    setBusy(true);
    try {
      setStatus(await tauriInvoke<HostStatus>(cmd));
      setNeedsRestart(false);
      if (cmd !== "host_stop") {
        // Reconnect our own saved entry for this server after a restart.
        servers.value.filter((s) => s.saved.value.hosted).forEach((s) => setTimeout(() => s.conn.retryNow(), 300));
      }
    } catch (e) {
      toast("Server konnte nicht gestartet werden", String(e), "error");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setExposure = async (exposed: boolean) => {
    if (!cfg) return;
    if (exposed && !(await confirmDialog({ title: "Server im Netzwerk freigeben?", body: exposureWarning(cfg), confirm: "Verstanden, freigeben", danger: true }))) return;
    set((c) => ({ ...c, bind: exposed ? "0.0.0.0" : "127.0.0.1", public_host: exposed && !c.public_host ? status.lan_ip ?? "" : c.public_host }));
  };

  const hostedEntry = servers.value.find((s) => s.saved.value.hosted);
  const exposed = cfg ? cfg.bind !== "127.0.0.1" && cfg.bind !== "::1" : false;

  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3>Servermodus</h3>
        <div style={{ padding: "6px 10px" }} class="col">
          {status.running ? <span class="badge ok">● läuft</span> : <span class="badge">○ gestoppt</span>}
          {status.address && <span class="mono xs">{status.address}</span>}
          {status.running && (status.exposed ? <span class="badge warn">im Netzwerk erreichbar</span> : <span class="badge ok">nur dieser PC</span>)}
        </div>
        <div class="col" style={{ padding: "10px" }}>
          {!status.running ? (
            <button class="btn primary block" disabled={busy || !cfg} onClick={() => void run("host_start")}>{busy ? <Spinner /> : "Server starten"}</button>
          ) : (
            <>
              <button class="btn block" disabled={busy} onClick={() => void run("host_restart")}>Neu starten</button>
              <button class="btn danger block" disabled={busy} onClick={async () => {
                if (await confirmDialog({ title: "Server stoppen?", body: "Alle verbundenen Benutzer werden getrennt.", confirm: "Stoppen", danger: true })) void run("host_stop");
              }}>Stoppen</button>
            </>
          )}
        </div>
      </nav>
      <div class="pane-content" style={{ position: "relative" }}>
        <div class="pane-close"><IconButton title="Schließen (Esc)" onClick={closeModal}><Icon.X /></IconButton></div>
        <h2>Eigenen Server betreiben</h2>
        <div class="faint small">Der Server läuft in dieser App und bleibt aktiv, wenn das Fenster geschlossen wird (Symbol im Infobereich). Daten: <span class="mono selectable">{status.data_dir}</span></div>
        {status.error && <div class="notice danger">{status.error}</div>}
        {cfgError && (
          <div class="notice danger col">
            <div>Die Serverkonfiguration ist beschädigt: {cfgError}</div>
            <button class="btn sm" onClick={async () => { await tauriInvoke("host_config_reset"); await refresh(); toast("Konfiguration zurückgesetzt", "Eine Kopie der alten Datei wurde als server.toml.broken gespeichert.", "info"); }}>Auf Standard zurücksetzen</button>
          </div>
        )}
        {needsRestart && (
          <div class="notice warn row">
            <span class="grow">Änderungen werden nach einem Neustart des Servers wirksam.</span>
            <button class="btn sm" onClick={() => void run("host_restart")}>Jetzt neu starten</button>
          </div>
        )}
        {status.running && status.setup_code && cfg && <OwnerSetup status={status} cfg={cfg} onDone={() => void refresh()} />}
        {status.running && !status.setup_code && !hostedEntry && cfg && (
          <div class="notice">Der Server ist bereits eingerichtet. Füge ihn über „Server hinzufügen“ mit der Adresse <span class="mono selectable">{localAddress(cfg)}</span> hinzu und melde dich an.</div>
        )}
        {status.running && status.fingerprint && (
          <div class="card row">
            <div class="grow" style={{ minWidth: "0px" }}>
              <div class="label">Zertifikat-Fingerabdruck (SHA-256)</div>
              <div class="mono xs selectable" style={{ wordBreak: "break-all" }}>{status.fingerprint}</div>
            </div>
            <IconButton title="Kopieren" onClick={() => copyText(status.fingerprint!)}><Icon.Copy /></IconButton>
          </div>
        )}
        {cfg && (
          <>
            <div class="card col">
              <div class="label">Erreichbarkeit</div>
              <label class="checkbox">
                <input type="radio" name="exp" checked={!exposed} onChange={() => void setExposure(false)} />
                <span><b>Nur dieser PC</b> <span class="faint small">(127.0.0.1 – sicherer Standard, z. B. zum Testen)</span></span>
              </label>
              <label class="checkbox">
                <input type="radio" name="exp" checked={exposed} onChange={() => void setExposure(true)} />
                <span><b>Lokales Netzwerk / Internet</b> <span class="faint small">(alle Netzwerkschnittstellen)</span></span>
              </label>
              <div class="row" style={{ gap: "10px" }}>
                <Field label="TCP-Port">
                  <input class="input" type="number" min={1} max={65535} value={cfg.port} onInput={(e) => set((c) => ({ ...c, port: Number((e.target as HTMLInputElement).value) }))} />
                </Field>
                <Field label="Öffentliche Adresse (für Einladungslinks)" hint={status.lan_ip ? `LAN-IP dieses PCs: ${status.lan_ip}` : undefined}>
                  <input class="input" placeholder="z. B. 192.168.1.20 oder chat.example.org" value={cfg.public_host} onInput={(e) => set((c) => ({ ...c, public_host: (e.target as HTMLInputElement).value.trim() }))} />
                </Field>
              </div>
              {exposed && <div class="notice warn small">{exposureWarning(cfg)}</div>}
            </div>
            <div class="card col">
              <div class="label">Sicherheit</div>
              <Toggle checked={cfg.tls.enabled} onChange={(x) => set((c) => ({ ...c, tls: { ...c.tls, enabled: x } }))} label="TLS-Verschlüsselung (empfohlen)" desc="Ohne eigenes Zertifikat wird ein selbst signiertes erzeugt; Clients prüfen dessen Fingerabdruck." />
              {cfg.tls.enabled && (
                <div class="row" style={{ gap: "10px" }}>
                  <Field label="Eigenes Zertifikat (PEM, optional)"><input class="input" value={cfg.tls.cert_path} placeholder="C:\…\fullchain.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, cert_path: (e.target as HTMLInputElement).value } }))} /></Field>
                  <Field label="Privater Schlüssel (PEM)"><input class="input" value={cfg.tls.key_path} placeholder="C:\…\privkey.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, key_path: (e.target as HTMLInputElement).value } }))} /></Field>
                </div>
              )}
              {!cfg.tls.enabled && <div class="notice danger small">Ohne TLS werden Passwörter und Nachrichten unverschlüsselt übertragen. Nur hinter einem TLS-Reverse-Proxy oder zum lokalen Testen verwenden.</div>}
            </div>
            <div class="card col">
              <div class="label">Sprache & Video (NAT-Traversal)</div>
              <Toggle checked={cfg.media.stun_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, stun_enabled: x } }))} label="Integrierter STUN-Dienst" desc="Hilft Clients hinter Routern, direkte Verbindungen aufzubauen. Kein externer Dienst nötig." />
              <Toggle checked={cfg.media.turn_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, turn_enabled: x } }))} label="Integrierter TURN-Relay" desc="Leitet Audio/Video weiter, wenn keine direkte Verbindung möglich ist (strikte NAT/Firewalls). Erzeugt Last auf diesem PC." />
              <div class="row" style={{ gap: "10px" }}>
                <Field label="UDP-Port"><input class="input" type="number" value={cfg.media.udp_port} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, udp_port: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                <Field label="Max. Teilnehmer pro Sprachkanal"><input class="input" type="number" min={1} max={50} value={cfg.media.max_voice_participants} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, max_voice_participants: Number((e.target as HTMLInputElement).value) } }))} /></Field>
              </div>
              {cfg.media.turn_enabled && (
                <div class="row" style={{ gap: "10px" }}>
                  <Field label="Relay-IP (leer = automatisch)"><input class="input" value={cfg.media.relay_ip} placeholder={status.lan_ip ?? ""} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_ip: (e.target as HTMLInputElement).value.trim() } }))} /></Field>
                  <Field label="Relay-Ports von"><input class="input" type="number" value={cfg.media.relay_port_min} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_min: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                  <Field label="bis"><input class="input" type="number" value={cfg.media.relay_port_max} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_max: Number((e.target as HTMLInputElement).value) } }))} /></Field>
                </div>
              )}
              <div class="faint xs">Sprachkanäle verbinden Teilnehmer direkt miteinander (Mesh). Empfohlen sind bis zu ca. 8 Personen pro Kanal mit Bildübertragung.</div>
            </div>
            <div class="card col">
              <Toggle
                checked={hostAutostart.value}
                onChange={(x) => {
                  hostAutostart.value = x;
                  void persistNow();
                }}
                label="Server beim Start von NexusTalk automatisch starten"
                desc="In Kombination mit „Mit Windows starten“ (Einstellungen › App) läuft der Server nach der Anmeldung im Hintergrund."
              />
            </div>
            <div class="row">
              <button class="btn primary" disabled={!dirty} onClick={() => void save()}>Konfiguration speichern</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

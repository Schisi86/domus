// Hosting center: run several servers from this app, each on its own ports,
// with ready-made defaults and a permanent invite link per server.
// Exposure to the network is an explicit, confirmed step.

import { isAndroidApp } from "../../platform";
import { useEffect, useState } from "preact/hooks";
import { addServer, closeModal, removeServer, selectServer, servers, toast } from "../../state/app";
import { checkFirewall, clientFor, firewall, firewallOk, hostName, hosts, internetAddress, localAddress, openFirewall, refreshHosts, setRelay, startHost, startingHosts, whenReady, type HostConfig, type HostStatus } from "../../state/hosting";
import type { ServerStore } from "../../state/server";
import type { Invite, InviteLinkInfo } from "../../types";
import { errorText, t } from "../../i18n";
import { inviteLink, transport } from "../../net/transport";
import { appInfo, isTauri, tauriInvoke } from "../../platform";
import { Field, IconButton, Icon, Modal, Spinner, Toggle, confirmDialog, copyText, initials, promptDialog, useBlobUrl } from "../components";
import { deviceName } from "./AddServer";
import { linkFor } from "./Invite";

function isExposed(cfg: HostConfig) {
  return cfg.bind !== "127.0.0.1" && cfg.bind !== "::1";
}

function ExposureWarning({ cfg }: { cfg: Pick<HostConfig, "port" | "media"> }) {
  return (
    <div class="col" style={{ gap: "8px" }}>
      <div>{t("host.exposeText")}</div>
      <div>{t("host.portsNeeded")}</div>
      <ul style={{ margin: "0px", paddingInlineStart: "18px" }}>
        <li><b>TCP {cfg.port}</b> – {t("host.portTcp")}</li>
        {(cfg.media.stun_enabled || cfg.media.turn_enabled) && <li><b>UDP {cfg.media.udp_port}</b> – {cfg.media.turn_enabled ? t("host.portStunTurn") : t("host.portStun")}</li>}
        {cfg.media.turn_enabled && <li><b>UDP {cfg.media.relay_port_min}–{cfg.media.relay_port_max}</b> – {t("host.portRelay")}</li>}
      </ul>
      {!isAndroidApp && <div>{t("host.firewallText")}</div>}
    </div>
  );
}

/** Makes sure the Windows Firewall lets friends in; asks for admin rights once. */
async function ensureFirewall(): Promise<boolean> {
  const st = await checkFirewall();
  if (firewallOk(st)) return true;
  const r = await openFirewall();
  if (r === "ok") toast(t("rc.fwOpened"), undefined, "ok");
  else if (r === "cancelled") toast(t("rc.fwCancelled"), t("rc.fwBlockedDesc"), "warn", 9000);
  else toast(t("rc.fwFailed"), r, "error", 9000);
  return r === "ok";
}

function FirewallButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      class="btn primary sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await ensureFirewall();
        setBusy(false);
      }}
    >
      {busy ? <Spinner /> : <Icon.Shield size={14} />} {t("rc.fwOpen")}
    </button>
  );
}

/** What others need to reach this server – and whether it is in place. */
function ReachCheck({ h }: { h: HostStatus }) {
  useEffect(() => {
    void checkFirewall();
  }, [h.id, h.exposed]);
  const fw = firewall.value;
  const fwOk = firewallOk(fw);
  const u = h.upnp;
  const r = h.relay;
  const relayUp = !!r?.address;
  const [busy, setBusy] = useState(false);
  const toggleRelay = async (on: boolean) => {
    setBusy(true);
    try {
      await setRelay(h.id, on);
    } catch (e) {
      toast(errorText(e), undefined, "error");
    }
    setBusy(false);
  };
  const lanAddr = `${h.public_host || h.lan_ip || "?"}:${h.port}`;
  const Row = ({ ok, warn, children }: { ok: boolean; warn?: boolean; children: preact.ComponentChildren }) => (
    <div class={`reach-row${ok ? " ok" : warn ? " warn" : " bad"}`}>
      <span class="reach-dot">{ok ? "✓" : "!"}</span>
      <div class="grow">{children}</div>
    </div>
  );
  return (
    <div class="card col reach-check">
      <div class="label" style={{ margin: "0px" }}>{t("rc.title")}</div>
      <Row ok={h.running}>{h.running ? t("rc.running") : t("rc.stopped")}</Row>
      {fw === null ? (
        <div class="row faint small"><Spinner /> {t("rc.fwChecking")}</div>
      ) : (
        <Row ok={fwOk}>
          <div>{fwOk ? t("rc.fwOk") : t("rc.fwBlocked")}</div>
          {!fwOk && (
            <div class="col" style={{ gap: "8px", marginTop: "6px" }}>
              <div class="faint xs">{t("rc.fwBlockedDesc")}</div>
              <div><FirewallButton /></div>
            </div>
          )}
        </Row>
      )}
      <Row ok={fwOk && h.running}>{t("rc.lan", { addr: lanAddr })}</Row>
      {h.running && h.exposed && (
        <Row ok={relayUp} warn={!relayUp}>
          {!h.relay_enabled ? (
            <div>{t("rc.relayOff")}</div>
          ) : relayUp ? (
            <div>{t("rc.relayOk", { addr: r!.address! })}</div>
          ) : r?.error ? (
            <div>{t("rc.relayFailed", { error: r.error })}</div>
          ) : (
            <div class="row"><Spinner /> {t("rc.relayPending")}</div>
          )}
          <div class="col" style={{ gap: "8px", marginTop: "6px" }}>
            <div class="faint xs">{t("rc.relayNote")}</div>
            <div>
              <button class={`btn ${h.relay_enabled ? "ghost" : "primary"} sm`} disabled={busy} onClick={() => void toggleRelay(!h.relay_enabled)}>
                {busy ? <Spinner /> : <Icon.Globe size={14} />} {h.relay_enabled ? t("rc.relayDisable") : t("rc.relayEnable")}
              </button>
            </div>
          </div>
        </Row>
      )}
      {h.running &&
        (!u ? (
          <div class="row faint small"><Spinner /> {t("rc.upnpPending")}</div>
        ) : u.mapped && !u.cgnat ? (
          <Row ok>{t("rc.upnpOk", { ip: u.external_ip ?? "?" })}</Row>
        ) : relayUp ? null : u.mapped && u.cgnat ? (
          <Row ok={false} warn>{t("rc.upnpCgnat")}</Row>
        ) : (
          <Row ok={false} warn>{t("rc.upnpNo", { tcp: h.port, udp: h.udp_port, ip: h.lan_ip ?? "?" })}</Row>
        ))}
    </div>
  );
}

/** A permanent, unlimited invite – created automatically when missing. */
async function permanentInvite(s: ServerStore, renew = false): Promise<{ code: string; info: InviteLinkInfo }> {
  const r = await s.rpc<{ invites: Invite[]; link: InviteLinkInfo }>("invite.list");
  const old = r.invites.find((i) => i.expires_at === null && i.max_uses === null && i.role_id === null);
  if (old && !renew) return { code: old.code, info: r.link };
  if (old) await s.rpc("invite.delete", { code: old.code });
  const c = await s.rpc<{ code: string; link: InviteLinkInfo }>("invite.create", { max_uses: null, expires_hours: 0, role_id: null });
  return { code: c.code, info: c.link };
}

function InviteCard({ h, client }: { h: HostStatus; client: ServerStore }) {
  const [inv, setInv] = useState<{ code: string; info: InviteLinkInfo } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ready = client.conn.state.value === "ready";
  const load = async (renew = false) => {
    setError(null);
    try {
      setInv(await permanentInvite(client, renew));
    } catch (e) {
      setError(errorText(e));
    }
  };
  // Reload when the server comes up or its public address changes.
  useEffect(() => {
    if (ready) void load();
  }, [ready, h.public_host, h.port, h.running]);

  const shown = inv ? linkFor(client, inv.code, inv.info) : null;
  const pub = h.exposed ? internetAddress(h) : null;
  const net = inv && pub ? inviteLink(pub.host, pub.port, inv.code, inv.info.fingerprint) : null;
  const relayPending = h.exposed && !net && h.relay_enabled && !h.relay?.error;
  const copy = (l: string) => {
    copyText(l);
    toast(t("invite.copied"), undefined, "ok", 2000);
  };
  return (
    <div class="card col invite-hero">
      <div class="row">
        <span class="invite-ico"><Icon.Link size={18} /></span>
        <div class="grow">
          <div class="label" style={{ margin: "0px" }}>{t("hc.invite")}</div>
          <div class="faint xs">{t("hc.inviteHint")}</div>
        </div>
      </div>
      {!h.running ? (
        <div class="notice warn small">{t("hc.notRunning")}</div>
      ) : !shown ? (
        error ? <div class="error-text">{error}</div> : <div class="row faint small"><Spinner /> {t("hc.connecting")}</div>
      ) : (
        <>
          {h.exposed && !net && !firewallOk(firewall.value) && (
            <div class="notice warn small row">
              <span class="grow">{t("rc.notReachable")}</span>
              <FirewallButton />
            </div>
          )}
          {net && (
            <>
              <div class="label" style={{ margin: "0px" }}>
                {t("rc.linkNet")} <span class="faint xs">· {t("rc.linkNetHint")}</span>
              </div>
              <div class="invite-link mono selectable" onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>{net}</div>
            </>
          )}
          {relayPending && <div class="row faint small"><Spinner /> {t("rc.relayPending")}</div>}
          {net && <div class="label" style={{ margin: "0px" }}>{t("rc.linkLan")}</div>}
          <div class={`invite-link mono selectable${net ? " sub" : ""}`} onClick={(e) => getSelection()?.selectAllChildren(e.currentTarget)}>{shown.link}</div>
          <div class="row wrap" style={{ gap: "8px" }}>
            {net && (
              <button class="btn primary lg" onClick={() => copy(net)}>
                <Icon.Globe size={16} /> {t("rc.copyNet")}
              </button>
            )}
            <button class={`btn ${net ? "ghost" : "primary lg"}`} onClick={() => copy(shown.link)}>
              <Icon.Copy size={16} /> {net ? t("rc.copyLan") : t("invite.copyLink")}
            </button>
            <button
              class="btn ghost"
              onClick={async () => {
                if (await confirmDialog({ title: t("hc.newLink"), body: t("hc.newLinkBody"), confirm: t("hc.newLink") })) void load(true);
              }}
            >
              <Icon.Refresh size={15} /> {t("hc.newLink")}
            </button>
          </div>
          {!h.exposed && <div class="notice small">{t("hc.linkLocal")}</div>}
        </>
      )}
    </div>
  );
}

function OwnerSetup({ h }: { h: HostStatus }) {
  const known = servers.value.find((s) => s.saved.value.username)?.saved.value.username ?? "";
  const [username, setUsername] = useState(known);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!known) void appInfo().then((i) => i?.user_name && setUsername((u) => u || i.user_name.replace(/[^\p{L}\p{N}._-]/gu, "").slice(0, 32)));
  }, []);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const target = { address: localAddress(h), fingerprint: h.fingerprint };
      const r = await transport.http(target, "POST", "/api/v1/auth/register", null, { username, password, invite: h.setup_code, device: deviceName() });
      if (r.status !== 200) throw r.body?.error ?? { code: "INTERNAL", msg: `HTTP ${r.status}` };
      const id = crypto.randomUUID();
      const name = h.name || t("host.myServer");
      addServer({ id, address: target.address, fingerprint: h.fingerprint, name, username: r.body.user.username, token: r.body.token, hosted: true, host_id: h.id }, false);
      await tauriInvoke("host_setup_done", { id: h.id });
      const store = servers.value.find((s) => s.id === id);
      // Name the server and prepare the permanent invite right away.
      if (store && (await whenReady(store))) {
        await store.rpc("server.update", { name }).catch(() => {});
        await permanentInvite(store).catch(() => {});
      }
      toast(t("host.setupDone"), t("host.setupDoneBody"), "ok");
      await refreshHosts();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="card col owner-card">
      <div class="label" style={{ margin: "0px" }}>{t("host.ownerTitle")}</div>
      <div class="small muted">{t("host.ownerText")}</div>
      <div class="row wrap" style={{ gap: "10px" }}>
        <input class="input grow" placeholder={t("add.username")} autoComplete="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        <input
          class="input grow"
          type="password"
          autoFocus
          placeholder={t("host.pwPlaceholder")}
          autoComplete="new-password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => e.key === "Enter" && username && password.length >= 8 && void create()}
        />
        <button class="btn primary" disabled={busy || !username || password.length < 8} onClick={() => void create()}>{busy ? <Spinner /> : t("host.create")}</button>
      </div>
      {error && <div class="error-text">{error}</div>}
    </div>
  );
}

function Advanced({ h, cfg, setCfg, reload }: { h: HostStatus; cfg: HostConfig; setCfg: (c: HostConfig) => void; reload: () => Promise<void> }) {
  const [dirty, setDirty] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const set = (patch: (c: HostConfig) => HostConfig) => {
    setCfg(patch(structuredClone(cfg)));
    setDirty(true);
  };
  const save = async () => {
    try {
      await tauriInvoke("host_config_save", { id: h.id, config: { ...cfg, port: Number(cfg.port) } });
      setDirty(false);
      if (h.running) setNeedsRestart(true);
      toast(t("host.configSaved"), undefined, "ok");
      await reload();
    } catch (e) {
      toast(t("common.saveFailed"), String(e), "error");
    }
  };
  const num = (e: Event) => Number((e.target as HTMLInputElement).value);
  return (
    <details class="card advanced">
      <summary><Icon.Sliders size={16} /> {t("hc.advanced")}</summary>
      <div class="col" style={{ gap: "14px", marginTop: "12px" }}>
        {needsRestart && (
          <div class="notice warn row">
            <span class="grow">{t("host.needsRestart")}</span>
            <button
              class="btn sm"
              onClick={async () => {
                await tauriInvoke("host_restart", { id: h.id }).catch((e) => toast(t("host.startFailed"), String(e), "error"));
                setNeedsRestart(false);
                await reload();
              }}
            >
              {t("host.restartNow")}
            </button>
          </div>
        )}
        <div class="row wrap" style={{ gap: "10px" }}>
          <Field label={t("host.tcpPort")}><input class="input" type="number" min={1} max={65535} value={cfg.port} onInput={(e) => set((c) => ({ ...c, port: num(e) }))} /></Field>
          <Field label={t("host.publicAddress")} hint={h.lan_ip ? t("host.lanIp", { ip: h.lan_ip }) : undefined}>
            <input class="input" placeholder={t("host.publicPlaceholder")} value={cfg.public_host} onInput={(e) => set((c) => ({ ...c, public_host: (e.target as HTMLInputElement).value.trim() }))} />
          </Field>
        </div>
        <div class="col" style={{ gap: "10px" }}>
          <div class="label" style={{ margin: "0px" }}>{t("host.security")}</div>
          <Toggle checked={cfg.tls.enabled} onChange={(x) => set((c) => ({ ...c, tls: { ...c.tls, enabled: x } }))} label={t("host.tls")} desc={t("host.tlsDesc")} />
          {cfg.tls.enabled && (
            <div class="row wrap" style={{ gap: "10px" }}>
              <Field label={t("host.certPath")}><input class="input" value={cfg.tls.cert_path} placeholder="C:\…\fullchain.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, cert_path: (e.target as HTMLInputElement).value } }))} /></Field>
              <Field label={t("host.keyPath")}><input class="input" value={cfg.tls.key_path} placeholder="C:\…\privkey.pem" onInput={(e) => set((c) => ({ ...c, tls: { ...c.tls, key_path: (e.target as HTMLInputElement).value } }))} /></Field>
            </div>
          )}
          {!cfg.tls.enabled && <div class="notice danger small">{t("host.noTlsWarn")}</div>}
        </div>
        <div class="col" style={{ gap: "10px" }}>
          <div class="label" style={{ margin: "0px" }}>{t("host.media")}</div>
          <Toggle checked={cfg.media.stun_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, stun_enabled: x } }))} label={t("host.stun")} desc={t("host.stunDesc")} />
          <Toggle checked={cfg.media.turn_enabled} onChange={(x) => set((c) => ({ ...c, media: { ...c.media, turn_enabled: x } }))} label={t("host.turn")} desc={t("host.turnDesc")} />
          <div class="row wrap" style={{ gap: "10px" }}>
            <Field label={t("host.udpPort")}><input class="input" type="number" value={cfg.media.udp_port} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, udp_port: num(e) } }))} /></Field>
            <Field label={t("host.maxVoice")}><input class="input" type="number" min={1} max={50} value={cfg.media.max_voice_participants} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, max_voice_participants: num(e) } }))} /></Field>
          </div>
          {cfg.media.turn_enabled && (
            <div class="row wrap" style={{ gap: "10px" }}>
              <Field label={t("host.relayIp")}><input class="input" value={cfg.media.relay_ip} placeholder={h.lan_ip ?? ""} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_ip: (e.target as HTMLInputElement).value.trim() } }))} /></Field>
              <Field label={t("host.relayFrom")}><input class="input" type="number" value={cfg.media.relay_port_min} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_min: num(e) } }))} /></Field>
              <Field label={t("host.relayTo")}><input class="input" type="number" value={cfg.media.relay_port_max} onInput={(e) => set((c) => ({ ...c, media: { ...c.media, relay_port_max: num(e) } }))} /></Field>
            </div>
          )}
          <div class="faint xs">{t("host.meshHint")}</div>
        </div>
        <div class="faint xs">{t("host.intro")} <span class="mono selectable">{h.data_dir}</span></div>
        <div class="row">
          <button class="btn primary" disabled={!dirty} onClick={() => void save()}>{t("host.saveConfig")}</button>
        </div>
      </div>
    </details>
  );
}

function HostDetail({ h, onRemoved }: { h: HostStatus; onRemoved: () => void }) {
  const client = clientFor(h.id);
  const name = hostName(h, t("host.myServer"));
  const icon = useBlobUrl(client ?? null, client?.info.value?.icon ? `/api/v1/icon?v=${client.info.value.icon}` : null);
  const [cfg, setCfg] = useState<HostConfig | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = async () => {
    try {
      setCfg(await tauriInvoke<HostConfig>("host_config", { id: h.id }));
      setCfgError(null);
    } catch (e) {
      setCfgError(String(e));
    }
    await refreshHosts();
  };
  useEffect(() => {
    setCfg(null);
    void reload();
  }, [h.id]);

  const run = async (cmd: "host_start" | "host_stop" | "host_restart") => {
    setBusy(true);
    try {
      await tauriInvoke(cmd, { id: h.id });
      if (cmd !== "host_stop" && client) setTimeout(() => client.conn.retryNow(), 300);
    } catch (e) {
      toast(t("host.startFailed"), String(e), "error");
    } finally {
      await refreshHosts();
      setBusy(false);
    }
  };

  const setReach = async (exposed: boolean) => {
    if (!cfg || exposed === isExposed(cfg)) return;
    if (exposed && !(await confirmDialog({ title: t("host.exposeTitle"), body: <><ExposureWarning cfg={cfg} /><p>{t("rc.uacHint")}</p></>, confirm: t("host.exposeConfirm"), danger: true }))) return;
    const next = { ...cfg, bind: exposed ? "0.0.0.0" : "127.0.0.1", public_host: exposed && !cfg.public_host ? (h.lan_ip ?? "") : cfg.public_host };
    setBusy(true);
    try {
      await tauriInvoke("host_config_save", { id: h.id, config: next });
      if (h.running) await tauriInvoke("host_restart", { id: h.id });
      if (client) setTimeout(() => client.conn.retryNow(), 300);
      toast(t("hc.reachSaved"), undefined, "ok");
      if (exposed) await ensureFirewall();
    } catch (e) {
      toast(t("common.saveFailed"), String(e), "error");
    } finally {
      await reload();
      setBusy(false);
    }
  };

  const rename = async () => {
    const v = await promptDialog({ title: t("hc.rename"), label: t("hc.name") });
    const n = v?.trim();
    if (!n) return;
    await tauriInvoke("host_rename", { id: h.id, name: n });
    if (client?.conn.state.value === "ready") await client.rpc("server.update", { name: n }).catch((e) => toast(t("common.saveFailed"), errorText(e), "error"));
    await refreshHosts();
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: t("hc.removeTitle", { name }), body: t("hc.removeBody"), confirm: t("hc.remove"), danger: true }))) return;
    try {
      await tauriInvoke("host_remove", { id: h.id, deleteData: true });
      if (client) removeServer(client.id);
      toast(t("hc.removed"), undefined, "ok");
      await refreshHosts();
      onRemoved();
    } catch (e) {
      toast(t("common.error"), String(e), "error");
    }
  };

  const exposed = cfg ? isExposed(cfg) : h.exposed;
  return (
    <>
      <div class="host-head">
        <div class="host-avatar">{icon ? <img src={icon} alt="" /> : initials(name)}</div>
        <div class="grow" style={{ minWidth: "0px" }}>
          <div class="row" style={{ gap: "6px" }}>
            <h2 class="ellipsis">{name}</h2>
            <IconButton title={t("hc.rename")} onClick={() => void rename()}><Icon.Edit size={15} /></IconButton>
          </div>
          <div class="row wrap" style={{ gap: "6px" }}>
            {h.running ? <span class="badge ok">● {t("host.running")}</span> : <span class="badge">○ {t("host.stopped")}</span>}
            <span class="badge">{exposed ? t("hc.reachNet") : t("host.thisPcOnly")}</span>
            <span class="faint xs mono">TCP {h.port} · UDP {h.udp_port}</span>
          </div>
        </div>
        <div class="row" style={{ gap: "6px" }}>
          {h.running ? (
            <>
              {client && (
                <button class="btn" onClick={() => { selectServer(client.id); closeModal(); }} title={t("hc.openTitle")}>
                  <Icon.ExternalLink size={15} /> {t("hc.open")}
                </button>
              )}
              <IconButton title={t("host.restart")} disabled={busy} onClick={() => void run("host_restart")}><Icon.Refresh size={17} /></IconButton>
              <button
                class="btn danger"
                disabled={busy}
                onClick={async () => {
                  if (await confirmDialog({ title: t("host.stopTitle"), body: t("host.stopBody"), confirm: t("host.stop"), danger: true })) void run("host_stop");
                }}
              >
                <Icon.Stop size={14} /> {t("host.stop")}
              </button>
            </>
          ) : (
            <button class="btn primary" disabled={busy} onClick={() => void run("host_start")}>{busy ? <Spinner /> : <><Icon.Play size={14} /> {t("host.start")}</>}</button>
          )}
        </div>
      </div>

      {h.error && <div class="notice danger">{h.error}</div>}
      {cfgError && (
        <div class="notice danger col">
          <div>{t("host.configBroken", { detail: cfgError })}</div>
          <button
            class="btn sm"
            onClick={async () => {
              await tauriInvoke("host_config_reset", { id: h.id });
              await reload();
              toast(t("host.configReset"), t("host.configResetBody"), "info");
            }}
          >
            {t("host.resetConfig")}
          </button>
        </div>
      )}

      {h.running && h.setup_code && <OwnerSetup h={h} />}
      {client && !h.setup_code && <InviteCard h={h} client={client} />}
      {h.running && !h.setup_code && !client && <div class="notice">{t("host.alreadySetup", { address: localAddress(h) })}</div>}

      <div class="card col">
        <div class="label" style={{ margin: "0px" }}>{t("host.reach")}</div>
        <div class="reach-grid">
          <button class={`reach-opt${!exposed ? " on" : ""}`} disabled={busy || !cfg} onClick={() => void setReach(false)}>
            <Icon.Laptop size={22} />
            <b>{t("host.thisPcOnly")}</b>
            <span>{t("hc.reachLocalDesc")}</span>
          </button>
          <button class={`reach-opt${exposed ? " on" : ""}`} disabled={busy || !cfg} onClick={() => void setReach(true)}>
            <Icon.Globe size={22} />
            <b>{t("hc.reachNet")}</b>
            <span>{t("hc.reachNetDesc")}</span>
          </button>
        </div>
      </div>

      {exposed && <ReachCheck h={h} />}

      <div class="card col">
        <Toggle
          checked={h.autostart}
          onChange={async (x) => {
            await tauriInvoke("host_set_autostart", { id: h.id, autostart: x });
            await refreshHosts();
          }}
          label={t("host.autostart")}
          desc={t("host.autostartDesc")}
        />
      </div>

      {cfg && <Advanced h={h} cfg={cfg} setCfg={setCfg} reload={reload} />}

      <div class="row">
        <button class="btn ghost danger-text" onClick={() => void remove()}><Icon.Trash size={15} /> {t("hc.remove")}</button>
      </div>
    </>
  );
}

function NewServer({ onCreated, first }: { onCreated: (id: string) => void; first: boolean }) {
  const n = hosts.value.length + 1;
  const [name, setName] = useState(first ? t("host.myServer") : t("hc.defaultName", { n }));
  const [exposed, setExposed] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (exposed && !(await confirmDialog({ title: t("host.exposeTitle"), body: <><p style={{ marginTop: "0px" }}>{t("host.exposeText")}</p><p>{t("rc.uacHint")}</p></>, confirm: t("host.exposeConfirm") }))) return;
    setBusy(true);
    try {
      const st = await tauriInvoke<HostStatus>("host_create", { name: name.trim() || t("host.myServer"), exposed });
      await refreshHosts();
      onCreated(st.id);
      if (exposed) await ensureFirewall();
    } catch (e) {
      toast(t("host.startFailed"), String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="col new-server" style={{ gap: "16px" }}>
      <div class="col" style={{ gap: "4px" }}>
        <h2>{first ? t("hc.firstTitle") : t("hc.newTitle")}</h2>
        <div class="muted small">{first ? t("hc.emptyText") : t("hc.newSub")}</div>
      </div>
      <Field label={t("hc.name")}>
        <input class="input" value={name} maxLength={64} autoFocus onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
      </Field>
      <div class="reach-grid">
        <button class={`reach-opt${exposed ? " on" : ""}`} onClick={() => setExposed(true)}>
          <Icon.Globe size={22} />
          <b>{t("hc.reachNet")}</b>
          <span>{t("hc.reachNetDesc")}</span>
        </button>
        <button class={`reach-opt${!exposed ? " on" : ""}`} onClick={() => setExposed(false)}>
          <Icon.Laptop size={22} />
          <b>{t("host.thisPcOnly")}</b>
          <span>{t("hc.reachLocalDesc")}</span>
        </button>
      </div>
      <ul class="check-list small muted">
        <li><Icon.Check size={14} /> {t("hc.presetPorts")}</li>
        <li><Icon.Check size={14} /> {t("hc.presetTls")}</li>
        <li><Icon.Check size={14} /> {t("hc.presetInvite")}</li>
        <li><Icon.Check size={14} /> {t("hc.presetTray")}</li>
      </ul>
      <div class="row">
        <button class="btn primary lg" disabled={busy} onClick={() => void create()}>{busy ? <><Spinner /> {t("hc.creating")}</> : <><Icon.Play size={15} /> {t("hc.createStart")}</>}</button>
      </div>
    </div>
  );
}

export function HostDialog({ select }: { select?: string } = {}) {
  const [sel, setSel] = useState<string | null>(select ?? null);
  const [loaded, setLoaded] = useState(hosts.value.length > 0);
  useEffect(() => {
    if (!isTauri) return;
    void refreshHosts().then(() => setLoaded(true));
    const i = setInterval(() => void refreshHosts(), 1500);
    return () => clearInterval(i);
  }, []);

  if (!isTauri) {
    return (
      <Modal title={t("hc.title")} footer={<button class="btn" onClick={closeModal}>{t("common.close")}</button>}>
        <div class="muted">{t("host.browserOnly")}</div>
      </Modal>
    );
  }
  if (!loaded) return <Modal title={t("hc.title")}><Spinner /></Modal>;

  const list = hosts.value;
  const creating = sel === "new" || list.length === 0;
  const current = creating ? null : (list.find((h) => h.id === sel) ?? list[0]);

  return (
    <Modal wide class="host-modal">
      <nav class="pane-nav">
        <h3>{t("hc.myServers")}</h3>
        {list.map((h) => (
          <button key={h.id} class={current?.id === h.id ? "active" : ""} onClick={() => setSel(h.id)}>
            <span class={`dot${h.running ? " on" : ""}${h.error ? " err" : ""}`} />
            <span class="grow ellipsis">{hostName(h, t("host.myServer"))}</span>
            {h.running ? (
              <span class="faint xs mono">:{h.port}</span>
            ) : (
              <span
                class="host-quick"
                role="button"
                tabIndex={0}
                title={t("host.start")}
                onClick={async (e) => {
                  e.stopPropagation();
                  const err = await startHost(h.id);
                  if (err) toast(t("host.startFailed"), err, "error");
                }}
              >
                {startingHosts.value.has(h.id) ? <Spinner /> : <Icon.Play size={13} />}
              </span>
            )}
          </button>
        ))}
        <button class={`add-host${creating ? " active" : ""}`} onClick={() => setSel("new")}>
          <Icon.Plus size={15} /> {t("hc.new")}
        </button>
        <div class="faint xs" style={{ padding: "14px 10px 0" }}>{t("hc.navHint")}</div>
      </nav>
      <div class="pane-content">
        <div class="pane-close"><IconButton title={t("common.closeEsc")} onClick={closeModal}><Icon.X /></IconButton></div>
        {creating ? (
          <NewServer first={list.length === 0} onCreated={(id) => setSel(id)} />
        ) : (
          current && <HostDetail key={current.id} h={current} onRemoved={() => setSel(null)} />
        )}
      </div>
    </Modal>
  );
}

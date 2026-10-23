// Server administration: overview, roles, members, audit log, server logs,
// status/resources and backups. Every action is re-checked by the server.

import { useEffect, useState } from "preact/hooks";
import { closeModal, openModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Role, User } from "../../types";
import { has, P } from "../../types";
import { errorText, fmtBytes, fmtDuration, fmtStamp, permDesc, permName, PERMISSIONS, presenceText, regMode, t } from "../../i18n";
import { transport } from "../../net/transport";
import { Field, IconButton, Icon, Modal, Spinner, Toggle, confirmDialog } from "../components";
import { InviteDialog } from "./Invite";

type Tab = "overview" | "roles" | "members" | "audit" | "logs" | "status" | "backups";

function Overview({ server }: { server: ServerStore }) {
  const info = server.info.value!;
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    server.rpc("server.settings").then(
      (d) => {
        setData(d);
        setForm({ ...d.settings });
      },
      (e) => toast(t("common.loadFailed"), errorText(e), "error"),
    );
  }, []);
  if (!form) return <Spinner />;
  const set = (k: string, v: unknown) => setForm({ ...form, [k]: v });
  const save = async () => {
    if (form.registration_mode === "open" && data.settings.registration_mode !== "open") {
      if (!(await confirmDialog({ title: t("srv.openTitle"), body: t("srv.openBody"), confirm: t("srv.openAnyway"), danger: true }))) return;
    }
    setBusy(true);
    try {
      const s = await server.rpc("server.update", {
        name: form.name,
        description: form.description,
        registration_mode: form.registration_mode,
        uploads_enabled: form.uploads_enabled,
        max_upload_mb: Number(form.max_upload_mb),
        max_storage_mb: Number(form.max_storage_mb),
        retention_days: Number(form.retention_days),
      });
      setData({ ...data, settings: s });
      toast(t("common.saved"), undefined, "ok");
    } catch (e) {
      toast(t("common.saveFailed"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const uploadIcon = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast(t("common.imageTooLarge"), t("common.max2mb"), "warn");
      const r = await transport.upload(server.target(), "/api/v1/icon", server.token, f).catch((e) => ({ status: 0, body: { error: e } }));
      if (r.status === 200) toast(t("srv.iconUpdated"), undefined, "ok");
      else toast(t("common.uploadFailed"), errorText(r.body?.error), "error");
    };
    input.click();
  };
  const cfg = data.config;
  return (
    <>
      <h2>{t("srv.overview")}</h2>
      <div class="row" style={{ gap: "16px", alignItems: "flex-start" }}>
        <div class="col grow">
          <Field label={t("srv.name")}>
            <input class="input" value={form.name} maxLength={64} onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label={t("srv.description")}>
            <textarea class="textarea" value={form.description} maxLength={500} onInput={(e) => set("description", (e.target as HTMLTextAreaElement).value)} />
          </Field>
        </div>
        <div class="col" style={{ alignItems: "center" }}>
          <div class="label">{t("srv.icon")}</div>
          <button class="btn outline" onClick={uploadIcon}>{info.icon ? t("common.change") : t("common.upload")}</button>
        </div>
      </div>
      <Field label={t("srv.registration")} hint={t("srv.registrationHint")}>
        <select class="select" value={form.registration_mode} onChange={(e) => set("registration_mode", (e.target as HTMLSelectElement).value)}>
          {["closed", "invite", "approval", "open"].map((k) => (
            <option key={k} value={k}>{regMode(k)}</option>
          ))}
        </select>
      </Field>
      {form.registration_mode === "open" && cfg.exposed && <div class="notice danger">{t("srv.openExposed")}</div>}
      <div class="card col">
        <Toggle checked={form.uploads_enabled} onChange={(v) => set("uploads_enabled", v)} label={t("srv.uploads")} desc={t("srv.uploadsDesc")} />
        <div class="row" style={{ gap: "12px" }}>
          <Field label={t("srv.maxUpload")}>
            <input class="input" type="number" min={1} max={2048} value={form.max_upload_mb} onInput={(e) => set("max_upload_mb", (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label={t("srv.maxStorage")}>
            <input class="input" type="number" min={1} value={form.max_storage_mb} onInput={(e) => set("max_storage_mb", (e.target as HTMLInputElement).value)} />
          </Field>
        </div>
      </div>
      <Field label={t("srv.retention")} hint={t("srv.retentionHint")}>
        <input class="input" type="number" min={0} value={form.retention_days} onInput={(e) => set("retention_days", (e.target as HTMLInputElement).value)} />
      </Field>
      <div class="row">
        <button class="btn primary" disabled={busy} onClick={() => void save()}>{t("common.save")}</button>
        {server.can(P.CREATE_INVITES) && <button class="btn outline" onClick={() => openModal(<InviteDialog server={server} />)}>{t("srv.manageInvites")}</button>}
      </div>
      <div class="card">
        <div class="label" style={{ marginBottom: "8px" }}>{t("srv.network")}</div>
        <dl class="kv">
          <dt>{t("srv.address")}</dt>
          <dd class="mono">{cfg.bind}:{cfg.port} {cfg.exposed ? <span class="badge warn">{t("srv.exposed")}</span> : <span class="badge ok">{t("srv.localOnly")}</span>}</dd>
          <dt>{t("srv.publicAddress")}</dt>
          <dd class="mono">{cfg.public_host || "–"}</dd>
          <dt>TLS</dt>
          <dd>{cfg.tls ? t("common.active") : <span class="badge danger">{t("common.off")}</span>}</dd>
          {cfg.fingerprint && (<><dt>{t("cert.fingerprintShort")}</dt><dd class="mono xs selectable" style={{ wordBreak: "break-all" }}>{cfg.fingerprint}</dd></>)}
          <dt>STUN / TURN</dt>
          <dd>{cfg.stun ? "STUN ✓" : "STUN ✕"} · {cfg.turn ? "TURN ✓" : "TURN ✕"} (UDP {cfg.udp_port})</dd>
        </dl>
      </div>
    </>
  );
}

function RoleEditor({ server, role, onDone }: { server: ServerStore; role: Role | null; onDone: () => void }) {
  const [name, setName] = useState(role?.name ?? t("srv.newRole"));
  const [color, setColor] = useState(role?.color || "#2ee59d");
  const [useColor, setUseColor] = useState(!!role?.color);
  const [perms, setPerms] = useState(role?.permissions ?? P.VIEW_CHANNEL | P.SEND_MESSAGES | P.CONNECT | P.SPEAK);
  const [position, setPosition] = useState(String(role?.position ?? 15));
  const [isDefault, setIsDefault] = useState(role?.is_default ?? false);
  const save = async () => {
    const body = { name, color: useColor ? color : "", permissions: perms, position: Number(position), is_default: isDefault };
    try {
      if (role) await server.rpc("role.update", { role_id: role.id, ...body });
      else await server.rpc("role.create", body);
      toast(t("srv.roleSaved"), name, "ok");
      onDone();
    } catch (e) {
      toast(t("common.saveFailed"), errorText(e), "error");
    }
  };
  const remove = async () => {
    if (!role) return;
    if (await confirmDialog({ title: t("srv.deleteRoleTitle", { name: role.name }), body: t("srv.deleteRoleBody"), confirm: t("common.delete"), danger: true })) {
      server.rpc("role.delete", { role_id: role.id }).then(onDone, (e) => toast(t("common.deleteFailed"), errorText(e), "error"));
    }
  };
  return (
    <div class="col" style={{ gap: "14px" }}>
      <div class="row">
        <button class="btn ghost sm" onClick={onDone}>← {t("common.back")}</button>
        <h2 class="grow">{role ? t("srv.roleTitle", { name: role.name }) : t("srv.newRole")}</h2>
      </div>
      <div class="row wrap" style={{ gap: "12px" }}>
        <Field label={t("common.name")}><input class="input" value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
        <Field label={t("srv.rank")} hint={t("srv.rankHint")}><input class="input" type="number" style={{ width: "90px" }} value={position} onInput={(e) => setPosition((e.target as HTMLInputElement).value)} /></Field>
        <Field label={t("srv.color")}>
          <div class="row">
            <input type="checkbox" checked={useColor} onChange={(e) => setUseColor((e.target as HTMLInputElement).checked)} />
            <input type="color" value={color} disabled={!useColor} onInput={(e) => setColor((e.target as HTMLInputElement).value)} />
          </div>
        </Field>
      </div>
      <Toggle checked={isDefault} onChange={setIsDefault} label={t("srv.defaultRole")} desc={t("srv.defaultRoleDesc")} />
      <div class="perm-grid card">
        {PERMISSIONS.map((p) => [
          <div key={`${p.bit}a`}>
            <div>{permName(p.key)}</div>
            <div class="desc">{permDesc(p.key)}</div>
          </div>,
          <span class="toggle" key={`${p.bit}b`}>
            <input type="checkbox" checked={has(perms, p.bit)} onChange={(e) => setPerms((e.target as HTMLInputElement).checked ? perms | p.bit : perms & ~p.bit)} />
            <span />
          </span>,
        ])}
      </div>
      <div class="row">
        <button class="btn primary" onClick={() => void save()}>{t("common.save")}</button>
        {role && <button class="btn danger" onClick={() => void remove()}>{t("common.delete")}</button>}
      </div>
    </div>
  );
}

function Roles({ server }: { server: ServerStore }) {
  const [editing, setEditing] = useState<Role | null | "new">(null);
  if (editing) return <RoleEditor server={server} role={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;
  const roles = server.roles.value;
  const members = [...server.members.value.values()];
  return (
    <>
      <div class="row">
        <h2 class="grow">{t("srv.roles")}</h2>
        {server.can(P.MANAGE_ROLES) && <button class="btn primary" onClick={() => setEditing("new")}>{t("srv.createRole")}</button>}
      </div>
      <div class="faint small">{t("srv.rolesHint")}</div>
      <table class="table">
        <thead><tr><th>{t("srv.role")}</th><th>{t("srv.rank")}</th><th>{t("member.members")}</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td><span style={{ color: r.color || undefined, fontWeight: 600 }}>{r.name}</span> {r.is_default && <span class="badge">{t("srv.default")}</span>} {has(r.permissions, P.ADMINISTRATOR) && <span class="badge danger">Admin</span>}</td>
              <td>{r.position}</td>
              <td>{members.filter((m) => m.roles.includes(r.id)).length}</td>
              <td style={{ textAlign: "end" }}>{server.can(P.MANAGE_ROLES) && <button class="btn sm" onClick={() => setEditing(r)}>{t("common.edit")}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Members({ server }: { server: ServerStore }) {
  const [pending, setPending] = useState<User[]>([]);
  const [banned, setBanned] = useState<User[]>([]);
  const [filter, setFilter] = useState("");
  const canBan = server.can(P.BAN_MEMBERS);
  const reload = () => {
    if (!canBan) return;
    server.rpc<User[]>("member.list_status", { status: "pending" }).then(setPending, () => {});
    server.rpc<User[]>("member.list_status", { status: "banned" }).then(setBanned, () => {});
  };
  useEffect(reload, []);
  const act = (op: string, uid: number) => server.rpc(op, { user_id: uid }).then(reload, (e) => toast(t("common.actionFailed"), errorText(e), "error"));
  const f = filter.toLowerCase();
  const members = [...server.members.value.values()].filter((m) => !f || m.username.includes(f) || m.display_name.toLowerCase().includes(f));
  const roleNames = (ids: number[]) => server.roles.value.filter((r) => ids.includes(r.id)).map((r) => r.name).join(", ");
  return (
    <>
      <h2>{t("member.members")}</h2>
      {canBan && pending.length > 0 && (
        <div class="card col">
          <div class="label">{t("srv.pending", { n: pending.length })}</div>
          {pending.map((u) => (
            <div class="row" key={u.id}>
              <span class="grow"><b>{u.username}</b> <span class="faint xs">{t("srv.registeredAt", { when: fmtStamp(u.created_at) })}</span></span>
              <button class="btn sm primary" onClick={() => act("member.approve", u.id)}>{t("srv.approve")}</button>
              <button class="btn sm danger" onClick={() => act("member.reject", u.id)}>{t("srv.reject")}</button>
            </div>
          ))}
        </div>
      )}
      <input class="input" placeholder={t("srv.filterMembers")} value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <table class="table">
        <thead><tr><th>{t("srv.user")}</th><th>{t("srv.roles")}</th><th>{t("srv.status")}</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td><b>{m.display_name || m.username}</b> <span class="faint">@{m.username}</span> {m.is_owner && "👑"}</td>
              <td class="small">{roleNames(m.roles) || "–"}</td>
              <td class="small">{presenceText(m.presence)}</td>
              <td style={{ textAlign: "end" }}>
                {canBan && !m.is_owner && m.id !== server.me.value?.id && (
                  <button
                    class="btn sm danger"
                    onClick={async () => {
                      if (await confirmDialog({ title: t("member.banTitle", { name: m.username }), body: t("member.banBody"), confirm: t("member.ban"), danger: true })) act("member.ban", m.id);
                    }}
                  >
                    {t("member.ban")}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canBan && banned.length > 0 && (
        <div class="card col">
          <div class="label">{t("srv.bannedList", { n: banned.length })}</div>
          {banned.map((u) => (
            <div class="row" key={u.id}>
              <span class="grow">{u.username}</span>
              <button class="btn sm" onClick={() => act("member.unban", u.id)}>{t("srv.unban")}</button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Audit({ server }: { server: ServerStore }) {
  const [entries, setEntries] = useState<any[] | null>(null);
  useEffect(() => {
    server.rpc<any[]>("audit.list").then(setEntries, (e) => toast(t("common.loadFailed"), errorText(e), "error"));
  }, []);
  return (
    <>
      <h2>{t("srv.audit")}</h2>
      <div class="faint small">{t("srv.auditHint")}</div>
      {!entries ? <Spinner /> : (
        <table class="table">
          <thead><tr><th>{t("srv.time")}</th><th>{t("srv.actor")}</th><th>{t("srv.action")}</th><th>{t("srv.target")}</th><th>{t("srv.details")}</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td class="xs">{fmtStamp(e.ts)}</td>
                <td>{e.actor_id ? server.memberName(e.actor_id) : t("srv.system")}</td>
                <td class="mono xs">{e.action}</td>
                <td class="mono xs">{e.target}</td>
                <td class="xs selectable">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Logs({ server }: { server: ServerStore }) {
  const [lines, setLines] = useState<any[] | null>(null);
  const [level, setLevel] = useState("");
  const load = () => server.rpc<any[]>("server.logs", { limit: 400, level: level || null }).then(setLines, (e) => toast(t("common.loadFailed"), errorText(e), "error"));
  useEffect(() => void load(), [level]);
  return (
    <>
      <div class="row">
        <h2 class="grow">{t("srv.logs")}</h2>
        <select class="select" style={{ width: "160px" }} value={level} onChange={(e) => setLevel((e.target as HTMLSelectElement).value)}>
          <option value="">{t("srv.logAll")}</option>
          <option value="warn">{t("srv.logWarn")}</option>
          <option value="error">{t("srv.logError")}</option>
        </select>
        <IconButton title={t("common.refresh")} onClick={() => void load()}><Icon.Refresh /></IconButton>
      </div>
      <div class="faint small">{t("srv.logsHint")}</div>
      {!lines ? <Spinner /> : (
        <div class="log-view">
          {lines.map((l, i) => (
            <div key={i} class={l.level}>{new Date(l.ts).toLocaleTimeString()} {l.level.padEnd(5)} {l.message}</div>
          ))}
          {!lines.length && <span class="faint">{t("srv.noEntries")}</span>}
        </div>
      )}
    </>
  );
}

function Status({ server }: { server: ServerStore }) {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    const load = () => server.rpc("server.stats").then(setS, () => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  if (!s) return <Spinner />;
  return (
    <>
      <h2>{t("srv.statusTitle")}</h2>
      <dl class="kv card">
        <dt>{t("srv.version")}</dt><dd>{s.version}</dd>
        <dt>{t("srv.uptime")}</dt><dd>{fmtDuration(s.uptime_secs)}</dd>
        <dt>{t("srv.connections")}</dt><dd>{t("srv.connectionsValue", { c: s.connections, u: s.online_users })}</dd>
        <dt>{t("srv.inVoice")}</dt><dd>{s.voice_participants}</dd>
        <dt>{t("srv.memory")}</dt><dd>{s.memory_bytes ? fmtBytes(s.memory_bytes) : "–"}</dd>
        <dt>CPU</dt><dd>{s.cpu_percent ?? "–"} %</dd>
        <dt>{t("srv.database")}</dt><dd>{fmtBytes(s.db_bytes)} · {t("srv.messagesN", { n: s.messages })}</dd>
        <dt>{t("srv.files")}</dt><dd>{fmtBytes(s.uploads_bytes)}</dd>
      </dl>
      <div class="faint xs">{t("srv.statusHint")}</div>
    </>
  );
}

function Backups({ server }: { server: ServerStore }) {
  const [list, setList] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => server.rpc<any[]>("backup.list").then(setList, (e) => toast(t("common.loadFailed"), errorText(e), "error"));
  useEffect(() => void load(), []);
  const create = async () => {
    setBusy(true);
    try {
      const b = await server.rpc("backup.create");
      toast(t("srv.backupCreated"), b.name, "ok");
      void load();
    } catch (e) {
      toast(t("srv.backupFailed"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const restore = async (name: string) => {
    if (!(await confirmDialog({ title: t("srv.restoreTitle"), body: t("srv.restoreBody", { name }), confirm: t("srv.restore"), danger: true }))) return;
    try {
      await server.rpc("backup.restore", { name });
      toast(t("srv.restoring"), t("srv.restoringBody"), "info", 8000);
      closeModal();
    } catch (e) {
      toast(t("srv.restoreFailed"), errorText(e), "error");
    }
  };
  return (
    <>
      <div class="row">
        <h2 class="grow">{t("srv.backups")}</h2>
        <button class="btn primary" disabled={busy} onClick={() => void create()}>{t("srv.backupNow")}</button>
      </div>
      <div class="faint small">{t("srv.backupHint")}</div>
      {!list ? <Spinner /> : (
        <table class="table">
          <thead><tr><th>{t("srv.file")}</th><th>{t("srv.size")}</th><th>{t("srv.created")}</th><th /></tr></thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.name}>
                <td class="mono xs">{b.name}</td>
                <td>{fmtBytes(b.size)}</td>
                <td class="small">{fmtStamp(b.created_at)}</td>
                <td style={{ textAlign: "end" }}><button class="btn sm" onClick={() => void restore(b.name)}>{t("srv.restore")}</button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4} class="faint">{t("srv.noBackups")}</td></tr>}
          </tbody>
        </table>
      )}
    </>
  );
}

export function ServerSettingsDialog({ server }: { server: ServerStore }) {
  const owner = server.isOwner.value;
  const tabs: [Tab, string, boolean][] = [
    ["overview", t("srv.overview"), server.can(P.MANAGE_SERVER)],
    ["roles", t("srv.roles"), true],
    ["members", t("member.members"), true],
    ["audit", t("srv.audit"), server.can(P.VIEW_AUDIT_LOG)],
    ["logs", t("srv.logs"), server.can(P.MANAGE_SERVER)],
    ["status", t("srv.statusTitle"), server.can(P.MANAGE_SERVER) || server.can(P.VIEW_AUDIT_LOG)],
    ["backups", t("srv.backups"), owner],
  ];
  const visible = tabs.filter((x) => x[2]);
  const [tab, setTab] = useState<Tab>(visible[0][0]);
  if (!server.info.value) return <Modal title={t("rail.serverSettings")}><div class="muted">{t("conn.disconnected")}</div></Modal>;
  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3 class="ellipsis">{server.displayName()}</h3>
        {visible.map(([k, label]) => (
          <button key={k} class={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
        {owner && (
          <>
            <h3>{t("srv.danger")}</h3>
            <button
              class="danger"
              onClick={async () => {
                if (await confirmDialog({ title: t("srv.restartTitle"), body: t("srv.restartBody"), confirm: t("srv.restart") })) {
                  server.rpc("server.restart").then(() => toast(t("srv.restartRequested"), undefined, "info"), (e) => toast(t("common.error"), errorText(e), "error"));
                }
              }}
            >
              {t("srv.restart")}
            </button>
          </>
        )}
      </nav>
      <div class="pane-content">
        <div class="pane-close"><IconButton title={t("common.closeEsc")} onClick={closeModal}><Icon.X /></IconButton></div>
        {tab === "overview" && <Overview server={server} />}
        {tab === "roles" && <Roles server={server} />}
        {tab === "members" && <Members server={server} />}
        {tab === "audit" && <Audit server={server} />}
        {tab === "logs" && <Logs server={server} />}
        {tab === "status" && <Status server={server} />}
        {tab === "backups" && <Backups server={server} />}
      </div>
    </Modal>
  );
}

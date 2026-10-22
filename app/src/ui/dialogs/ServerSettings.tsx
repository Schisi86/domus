// Server administration: overview, roles, members, audit log, server logs,
// status/resources and backups. Every action is re-checked by the server.

import { useEffect, useState } from "preact/hooks";
import { closeModal, openModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Role, User } from "../../types";
import { has, P } from "../../types";
import { errorText, fmtBytes, fmtDuration, fmtStamp, PERMISSION_INFO, REG_MODES } from "../../i18n";
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
    server.rpc("server.settings").then((d) => {
      setData(d);
      setForm({ ...d.settings });
    }, (e) => toast("Laden fehlgeschlagen", errorText(e), "error"));
  }, []);
  if (!form) return <Spinner />;
  const set = (k: string, v: unknown) => setForm({ ...form, [k]: v });
  const save = async () => {
    if (form.registration_mode === "open" && data.settings.registration_mode !== "open") {
      const ok = await confirmDialog({
        title: "Registrierung für alle öffnen?",
        body: "Jede Person, die den Server erreicht, kann ein Konto anlegen und sofort schreiben. Für Server im Internet wird „Nur mit Einladung“ oder „Freischaltung“ empfohlen.",
        confirm: "Trotzdem öffnen",
        danger: true,
      });
      if (!ok) return;
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
      toast("Einstellungen gespeichert", undefined, "ok");
    } catch (e) {
      toast("Speichern fehlgeschlagen", errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const uploadIcon = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast("Bild zu groß", "Maximal 2 MB.", "warn");
      const r = await transport.upload(server.target(), "/api/v1/icon", server.token, f).catch((e) => ({ status: 0, body: { error: e } }));
      if (r.status === 200) toast("Symbol aktualisiert", undefined, "ok");
      else toast("Upload fehlgeschlagen", errorText(r.body?.error), "error");
    };
    input.click();
  };
  const cfg = data.config;
  return (
    <>
      <h2>Übersicht</h2>
      <div class="row" style={{ gap: "16px", alignItems: "flex-start" }}>
        <div class="col grow">
          <Field label="Servername">
            <input class="input" value={form.name} maxLength={64} onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Beschreibung">
            <textarea class="textarea" value={form.description} maxLength={500} onInput={(e) => set("description", (e.target as HTMLTextAreaElement).value)} />
          </Field>
        </div>
        <div class="col" style={{ alignItems: "center" }}>
          <div class="label">Symbol</div>
          <button class="btn outline" onClick={() => void uploadIcon()}>{info.icon ? "Ändern" : "Hochladen"}</button>
        </div>
      </div>
      <Field label="Registrierung" hint="Bestimmt, wer ein Konto anlegen darf.">
        <select class="select" value={form.registration_mode} onChange={(e) => set("registration_mode", (e.target as HTMLSelectElement).value)}>
          {Object.entries(REG_MODES).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </Field>
      {form.registration_mode === "open" && cfg.exposed && <div class="notice danger">Der Server ist im Netzwerk erreichbar und die Registrierung offen. Jeder mit Netzwerkzugriff kann beitreten.</div>}
      <div class="card col">
        <Toggle checked={form.uploads_enabled} onChange={(v) => set("uploads_enabled", v)} label="Dateiuploads erlauben" desc="Hochgeladene Dateien werden nie automatisch ausgeführt." />
        <div class="row" style={{ gap: "12px" }}>
          <Field label="Max. Dateigröße (MB)">
            <input class="input" type="number" min={1} max={2048} value={form.max_upload_mb} onInput={(e) => set("max_upload_mb", (e.target as HTMLInputElement).value)} />
          </Field>
          <Field label="Speicherlimit gesamt (MB)">
            <input class="input" type="number" min={1} value={form.max_storage_mb} onInput={(e) => set("max_storage_mb", (e.target as HTMLInputElement).value)} />
          </Field>
        </div>
      </div>
      <Field label="Aufbewahrung von Nachrichten (Tage)" hint="0 = unbegrenzt. Ältere Nachrichten und ihre Anhänge werden stündlich gelöscht.">
        <input class="input" type="number" min={0} value={form.retention_days} onInput={(e) => set("retention_days", (e.target as HTMLInputElement).value)} />
      </Field>
      <div class="row">
        <button class="btn primary" disabled={busy} onClick={() => void save()}>Speichern</button>
        {server.can(P.CREATE_INVITES) && <button class="btn outline" onClick={() => openModal(<InviteDialog server={server} />)}>Einladungen verwalten</button>}
      </div>
      <div class="card">
        <div class="label" style={{ marginBottom: "8px" }}>Netzwerk (nur in der Serverkonfiguration änderbar)</div>
        <dl class="kv">
          <dt>Adresse</dt><dd class="mono">{cfg.bind}:{cfg.port} {cfg.exposed ? <span class="badge warn">im Netzwerk erreichbar</span> : <span class="badge ok">nur lokal</span>}</dd>
          <dt>Öffentliche Adresse</dt><dd class="mono">{cfg.public_host || "–"}</dd>
          <dt>TLS</dt><dd>{cfg.tls ? "aktiv" : <span class="badge danger">aus</span>}</dd>
          {cfg.fingerprint && (<><dt>Fingerabdruck</dt><dd class="mono xs selectable" style={{ wordBreak: "break-all" }}>{cfg.fingerprint}</dd></>)}
          <dt>STUN / TURN</dt><dd>{cfg.stun ? "STUN an" : "STUN aus"} · {cfg.turn ? "TURN an" : "TURN aus"} (UDP {cfg.udp_port})</dd>
        </dl>
      </div>
    </>
  );
}

function RoleEditor({ server, role, onDone }: { server: ServerStore; role: Role | null; onDone: () => void }) {
  const [name, setName] = useState(role?.name ?? "Neue Rolle");
  const [color, setColor] = useState(role?.color || "#7c66ff");
  const [useColor, setUseColor] = useState(!!role?.color);
  const [perms, setPerms] = useState(role?.permissions ?? P.VIEW_CHANNEL | P.SEND_MESSAGES | P.CONNECT | P.SPEAK);
  const [position, setPosition] = useState(String(role?.position ?? 15));
  const [isDefault, setIsDefault] = useState(role?.is_default ?? false);
  const save = async () => {
    const body = { name, color: useColor ? color : "", permissions: perms, position: Number(position), is_default: isDefault };
    try {
      if (role) await server.rpc("role.update", { role_id: role.id, ...body });
      else await server.rpc("role.create", body);
      toast("Rolle gespeichert", name, "ok");
      onDone();
    } catch (e) {
      toast("Speichern fehlgeschlagen", errorText(e), "error");
    }
  };
  const remove = async () => {
    if (!role) return;
    if (await confirmDialog({ title: `Rolle „${role.name}“ löschen?`, body: "Alle Mitglieder verlieren diese Rolle.", confirm: "Löschen", danger: true })) {
      server.rpc("role.delete", { role_id: role.id }).then(onDone, (e) => toast("Löschen fehlgeschlagen", errorText(e), "error"));
    }
  };
  return (
    <div class="col" style={{ gap: "14px" }}>
      <div class="row">
        <IconButton title="Zurück" onClick={onDone}><Icon.ChevronDown class="icon" /></IconButton>
        <h2 class="grow">{role ? `Rolle: ${role.name}` : "Neue Rolle"}</h2>
      </div>
      <div class="row" style={{ gap: "12px" }}>
        <Field label="Name"><input class="input" value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Rang" hint="Höher = mächtiger"><input class="input" type="number" style={{ width: "90px" }} value={position} onInput={(e) => setPosition((e.target as HTMLInputElement).value)} /></Field>
        <Field label="Farbe">
          <div class="row">
            <input type="checkbox" checked={useColor} onChange={(e) => setUseColor((e.target as HTMLInputElement).checked)} />
            <input type="color" value={color} disabled={!useColor} onInput={(e) => setColor((e.target as HTMLInputElement).value)} />
          </div>
        </Field>
      </div>
      <Toggle checked={isDefault} onChange={setIsDefault} label="Standardrolle" desc="Neue Mitglieder ohne spezielle Einladung erhalten diese Rolle automatisch." />
      <div class="perm-grid card">
        {PERMISSION_INFO.map((p) => [
          <div key={`${p.bit}a`}>
            <div>{p.name}</div>
            <div class="desc">{p.desc}</div>
          </div>,
          <span class="toggle" key={`${p.bit}b`}>
            <input type="checkbox" checked={has(perms, p.bit)} onChange={(e) => setPerms((e.target as HTMLInputElement).checked ? perms | p.bit : perms & ~p.bit)} />
            <span />
          </span>,
        ])}
      </div>
      <div class="row">
        <button class="btn primary" onClick={() => void save()}>Speichern</button>
        {role && <button class="btn danger" onClick={() => void remove()}>Löschen</button>}
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
        <h2 class="grow">Rollen</h2>
        {server.can(P.MANAGE_ROLES) && <button class="btn primary" onClick={() => setEditing("new")}>Rolle erstellen</button>}
      </div>
      <div class="faint small">Rollen bündeln Berechtigungen. Du kannst nur Rollen bearbeiten und vergeben, die unter deiner höchsten Rolle stehen. Der Serverinhaber hat immer alle Rechte.</div>
      <table class="table">
        <thead><tr><th>Rolle</th><th>Rang</th><th>Mitglieder</th><th /></tr></thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td><span style={{ color: r.color || undefined, fontWeight: 600 }}>{r.name}</span> {r.is_default && <span class="badge">Standard</span>} {has(r.permissions, P.ADMINISTRATOR) && <span class="badge danger">Admin</span>}</td>
              <td>{r.position}</td>
              <td>{members.filter((m) => m.roles.includes(r.id)).length}</td>
              <td style={{ textAlign: "right" }}>{server.can(P.MANAGE_ROLES) && <button class="btn sm" onClick={() => setEditing(r)}>Bearbeiten</button>}</td>
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
  const act = (op: string, uid: number) => server.rpc(op, { user_id: uid }).then(reload, (e) => toast("Aktion fehlgeschlagen", errorText(e), "error"));
  const members = [...server.members.value.values()].filter((m) => !filter || m.username.includes(filter.toLowerCase()) || m.display_name.toLowerCase().includes(filter.toLowerCase()));
  const roleNames = (ids: number[]) => server.roles.value.filter((r) => ids.includes(r.id)).map((r) => r.name).join(", ");
  return (
    <>
      <h2>Mitglieder</h2>
      {canBan && pending.length > 0 && (
        <div class="card col">
          <div class="label">Warten auf Freischaltung ({pending.length})</div>
          {pending.map((u) => (
            <div class="row" key={u.id}>
              <span class="grow"><b>{u.username}</b> <span class="faint xs">registriert {fmtStamp(u.created_at)}</span></span>
              <button class="btn sm primary" onClick={() => act("member.approve", u.id)}>Freischalten</button>
              <button class="btn sm danger" onClick={() => act("member.reject", u.id)}>Ablehnen</button>
            </div>
          ))}
        </div>
      )}
      <input class="input" placeholder="Mitglieder filtern" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
      <table class="table">
        <thead><tr><th>Benutzer</th><th>Rollen</th><th>Status</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td><b>{m.display_name || m.username}</b> <span class="faint">@{m.username}</span> {m.is_owner && "👑"}</td>
              <td class="small">{roleNames(m.roles) || "–"}</td>
              <td class="small">{m.presence}</td>
              <td style={{ textAlign: "right" }}>
                {canBan && !m.is_owner && m.id !== server.me.value?.id && (
                  <button
                    class="btn sm danger"
                    onClick={async () => {
                      if (await confirmDialog({ title: `${m.username} sperren?`, body: "Der Benutzer wird getrennt und kann sich nicht mehr anmelden.", confirm: "Sperren", danger: true })) act("member.ban", m.id);
                    }}
                  >
                    Sperren
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canBan && banned.length > 0 && (
        <div class="card col">
          <div class="label">Gesperrt ({banned.length})</div>
          {banned.map((u) => (
            <div class="row" key={u.id}>
              <span class="grow">{u.username}</span>
              <button class="btn sm" onClick={() => act("member.unban", u.id)}>Entsperren</button>
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
    server.rpc<any[]>("audit.list").then(setEntries, (e) => toast("Laden fehlgeschlagen", errorText(e), "error"));
  }, []);
  return (
    <>
      <h2>Audit-Protokoll</h2>
      <div class="faint small">Moderations- und sicherheitsrelevante Aktionen (letzte 100).</div>
      {!entries ? <Spinner /> : (
        <table class="table">
          <thead><tr><th>Zeit</th><th>Akteur</th><th>Aktion</th><th>Ziel</th><th>Details</th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td class="xs">{fmtStamp(e.ts)}</td>
                <td>{e.actor_id ? server.memberName(e.actor_id) : "System"}</td>
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
  const load = () => server.rpc<any[]>("server.logs", { limit: 400, level: level || null }).then(setLines, (e) => toast("Laden fehlgeschlagen", errorText(e), "error"));
  useEffect(() => void load(), [level]);
  return (
    <>
      <div class="row">
        <h2 class="grow">Serverprotokoll</h2>
        <select class="select" style={{ width: "150px" }} value={level} onChange={(e) => setLevel((e.target as HTMLSelectElement).value)}>
          <option value="">Alle</option>
          <option value="warn">Warnungen+</option>
          <option value="error">Nur Fehler</option>
        </select>
        <IconButton title="Aktualisieren" onClick={() => void load()}><Icon.Refresh /></IconButton>
      </div>
      <div class="faint small">Die letzten Einträge aus dem Arbeitsspeicher. Vollständige Protokolle liegen im Ordner „logs“ des Servers. Nachrichteninhalte und Passwörter werden nie protokolliert.</div>
      {!lines ? <Spinner /> : (
        <div class="log-view">
          {lines.map((l, i) => (
            <div key={i} class={l.level}>{new Date(l.ts).toLocaleTimeString("de-DE")} {l.level.padEnd(5)} {l.message}</div>
          ))}
          {!lines.length && <span class="faint">Keine Einträge.</span>}
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
    // Refresh only while this tab is open.
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <Spinner />;
  return (
    <>
      <h2>Status & Ressourcen</h2>
      <dl class="kv card">
        <dt>Version</dt><dd>{s.version}</dd>
        <dt>Laufzeit</dt><dd>{fmtDuration(s.uptime_secs)}</dd>
        <dt>Verbindungen</dt><dd>{s.connections} ({s.online_users} Benutzer online)</dd>
        <dt>In Sprachkanälen</dt><dd>{s.voice_participants}</dd>
        <dt>Arbeitsspeicher</dt><dd>{s.memory_bytes ? fmtBytes(s.memory_bytes) : "–"}</dd>
        <dt>CPU</dt><dd>{s.cpu_percent ?? "–"} %</dd>
        <dt>Datenbank</dt><dd>{fmtBytes(s.db_bytes)} · {s.messages} Nachrichten</dd>
        <dt>Dateien</dt><dd>{fmtBytes(s.uploads_bytes)}</dd>
      </dl>
      <div class="faint xs">Werte des Serverprozesses; wird alle 5 Sekunden aktualisiert, solange diese Seite geöffnet ist.</div>
    </>
  );
}

function Backups({ server }: { server: ServerStore }) {
  const [list, setList] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => server.rpc<any[]>("backup.list").then(setList, (e) => toast("Laden fehlgeschlagen", errorText(e), "error"));
  useEffect(() => void load(), []);
  const create = async () => {
    setBusy(true);
    try {
      const b = await server.rpc("backup.create");
      toast("Sicherung erstellt", b.name, "ok");
      void load();
    } catch (e) {
      toast("Sicherung fehlgeschlagen", errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const restore = async (name: string) => {
    if (!(await confirmDialog({ title: "Sicherung wiederherstellen?", body: `Der Server startet neu und lädt „${name}“. Alle Änderungen seit dieser Sicherung gehen verloren (die aktuelle Datenbank wird als Kopie aufbewahrt).`, confirm: "Wiederherstellen", danger: true }))) return;
    try {
      await server.rpc("backup.restore", { name });
      toast("Wiederherstellung läuft", "Der Server startet neu, die Verbindung wird automatisch wiederhergestellt.", "info", 8000);
      closeModal();
    } catch (e) {
      toast("Wiederherstellung fehlgeschlagen", errorText(e), "error");
    }
  };
  return (
    <>
      <div class="row">
        <h2 class="grow">Sicherungen</h2>
        <button class="btn primary" disabled={busy} onClick={() => void create()}>Jetzt sichern</button>
      </div>
      <div class="faint small">Sichert die Datenbank (Konten, Rollen, Kanäle, Nachrichten, Einstellungen) im Ordner „backups“. Hochgeladene Dateien liegen im Ordner „uploads“ und sollten zusätzlich gesichert werden. Es werden höchstens 20 Sicherungen aufbewahrt.</div>
      {!list ? <Spinner /> : (
        <table class="table">
          <thead><tr><th>Datei</th><th>Größe</th><th>Erstellt</th><th /></tr></thead>
          <tbody>
            {list.map((b) => (
              <tr key={b.name}>
                <td class="mono xs">{b.name}</td>
                <td>{fmtBytes(b.size)}</td>
                <td class="small">{fmtStamp(b.created_at)}</td>
                <td style={{ textAlign: "right" }}><button class="btn sm" onClick={() => void restore(b.name)}>Wiederherstellen</button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={4} class="faint">Noch keine Sicherungen.</td></tr>}
          </tbody>
        </table>
      )}
    </>
  );
}

export function ServerSettingsDialog({ server }: { server: ServerStore }) {
  const owner = server.isOwner.value;
  const tabs: [Tab, string, boolean][] = [
    ["overview", "Übersicht", server.can(P.MANAGE_SERVER)],
    ["roles", "Rollen", true],
    ["members", "Mitglieder", true],
    ["audit", "Audit-Protokoll", server.can(P.VIEW_AUDIT_LOG)],
    ["logs", "Serverprotokoll", server.can(P.MANAGE_SERVER)],
    ["status", "Status", server.can(P.MANAGE_SERVER) || server.can(P.VIEW_AUDIT_LOG)],
    ["backups", "Sicherungen", owner],
  ];
  const visible = tabs.filter((t) => t[2]);
  const [tab, setTab] = useState<Tab>(visible[0][0]);
  if (!server.info.value) return <Modal title="Servereinstellungen"><div class="muted">Nicht verbunden.</div></Modal>;
  return (
    <Modal wide>
      <nav class="pane-nav">
        <h3 class="ellipsis">{server.displayName()}</h3>
        {visible.map(([k, label]) => (
          <button key={k} class={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
        {owner && (
          <>
            <h3>Gefahrenzone</h3>
            <button
              class="danger"
              onClick={async () => {
                if (await confirmDialog({ title: "Server neu starten?", body: "Alle Verbindungen werden kurz getrennt und automatisch wiederhergestellt.", confirm: "Neu starten" })) {
                  server.rpc("server.restart").then(() => toast("Neustart angefordert", undefined, "info"), (e) => toast("Fehler", errorText(e), "error"));
                }
              }}
            >
              Server neu starten
            </button>
          </>
        )}
      </nav>
      <div class="pane-content" style={{ position: "relative" }}>
        <div class="pane-close"><IconButton title="Schließen (Esc)" onClick={closeModal}><Icon.X /></IconButton></div>
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

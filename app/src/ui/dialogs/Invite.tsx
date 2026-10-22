// Create and manage invites. The link embeds the certificate fingerprint so
// invited users can verify the server automatically.

import { useEffect, useState } from "preact/hooks";
import { closeModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Invite, InviteLinkInfo } from "../../types";
import { P } from "../../types";
import { errorText, fmtStamp } from "../../i18n";
import { inviteLink, normalizeAddress } from "../../net/transport";
import { Field, IconButton, Icon, Modal, copyText } from "../components";

export function linkFor(server: ServerStore, code: string, info: InviteLinkInfo | null) {
  const n = normalizeAddress(server.saved.value.address);
  const host = info?.host || n?.host || "localhost";
  const port = info?.port ?? Number(n?.base.split(":").pop() ?? 7878);
  const fp = info?.fingerprint ?? server.saved.value.fingerprint ?? null;
  return { link: info?.tls === false ? `http://${host}:${port} (Code ${code})` : inviteLink(host, port, code, fp), host, local: /^(localhost|127\.|::1)/.test(host) };
}

export function InviteDialog({ server }: { server: ServerStore }) {
  const [maxUses, setMaxUses] = useState("10");
  const [hours, setHours] = useState("168");
  const [roleId, setRoleId] = useState<string>("");
  const [created, setCreated] = useState<{ code: string; link: InviteLinkInfo } | null>(null);
  const [list, setList] = useState<Invite[]>([]);
  const [linkInfo, setLinkInfo] = useState<InviteLinkInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const canRoles = server.can(P.MANAGE_ROLES);

  const reload = () =>
    server.rpc<{ invites: Invite[]; link: InviteLinkInfo }>("invite.list").then(
      (r) => {
        setList(r.invites);
        setLinkInfo(r.link);
      },
      () => {},
    );
  useEffect(() => void reload(), []);

  const create = async () => {
    setBusy(true);
    try {
      const r = await server.rpc<{ code: string; link: InviteLinkInfo }>("invite.create", {
        max_uses: Number(maxUses) || null,
        expires_hours: Number(hours),
        role_id: roleId ? Number(roleId) : null,
      });
      setCreated(r);
      void reload();
    } catch (e) {
      toast("Einladung fehlgeschlagen", errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const shown = created ? linkFor(server, created.code, created.link) : null;
  return (
    <Modal title={`Personen zu ${server.displayName()} einladen`} footer={<button class="btn" onClick={closeModal}>Fertig</button>}>
      {!server.can(P.CREATE_INVITES) && <div class="notice warn">Du darfst auf diesem Server keine Einladungen erstellen.</div>}
      {shown && created && (
        <div class="col">
          <Field label="Einladungslink">
            <div class="row">
              <input class="input mono small" readOnly value={shown.link} onFocus={(e) => (e.target as HTMLInputElement).select()} />
              <button class="btn primary" onClick={() => { copyText(shown.link); toast("Link kopiert", undefined, "ok", 2000); }}>Kopieren</button>
            </div>
          </Field>
          <div class="kv">
            <dt>Code</dt>
            <dd class="mono selectable">{created.code}</dd>
          </div>
          {shown.local && (
            <div class="notice warn">
              Der Link enthält eine lokale Adresse ({shown.host}) und funktioniert nur auf diesem PC. Trage in den Servereinstellungen unter „Öffentliche Adresse“ die IP oder den Hostnamen ein, unter dem andere den Server erreichen.
            </div>
          )}
        </div>
      )}
      <div class="row" style={{ gap: "10px", alignItems: "flex-end" }}>
        <Field label="Max. Nutzungen">
          <select class="select" value={maxUses} onChange={(e) => setMaxUses((e.target as HTMLSelectElement).value)}>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="50">50</option>
            <option value="0">Unbegrenzt</option>
          </select>
        </Field>
        <Field label="Gültig für">
          <select class="select" value={hours} onChange={(e) => setHours((e.target as HTMLSelectElement).value)}>
            <option value="1">1 Stunde</option>
            <option value="24">1 Tag</option>
            <option value="168">7 Tage</option>
            <option value="720">30 Tage</option>
            {server.can(P.MANAGE_SERVER) && <option value="0">Unbegrenzt</option>}
          </select>
        </Field>
        {canRoles && (
          <Field label="Rolle">
            <select class="select" value={roleId} onChange={(e) => setRoleId((e.target as HTMLSelectElement).value)}>
              <option value="">Standard</option>
              {server.roles.value.map((r) => (
                <option value={r.id} key={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>
        )}
        <button class="btn primary" disabled={busy || !server.can(P.CREATE_INVITES)} onClick={() => void create()}>Erstellen</button>
      </div>
      {list.length > 0 && (
        <div>
          <div class="label" style={{ marginBottom: "6px" }}>Aktive Einladungen</div>
          <table class="table">
            <thead>
              <tr><th>Code</th><th>Nutzungen</th><th>Läuft ab</th><th /></tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.code}>
                  <td class="mono selectable">{i.code}</td>
                  <td>{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ""}</td>
                  <td>{i.expires_at ? fmtStamp(i.expires_at) : "nie"}</td>
                  <td style={{ textAlign: "right" }}>
                    <IconButton title="Link kopieren" class="sm" onClick={() => { copyText(linkFor(server, i.code, linkInfo).link); toast("Link kopiert", undefined, "ok", 2000); }}><Icon.Copy /></IconButton>
                    <IconButton
                      title="Widerrufen"
                      class="sm on-danger"
                      onClick={() => server.rpc("invite.delete", { code: i.code }).then(reload, (e) => toast("Fehler", errorText(e), "error"))}
                    >
                      <Icon.Trash />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

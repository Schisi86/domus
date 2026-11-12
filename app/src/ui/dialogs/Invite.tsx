// Create and manage invites. The link embeds the certificate fingerprint so
// invited users can verify the server automatically.

import { useEffect, useState } from "preact/hooks";
import { closeModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Invite, InviteLinkInfo } from "../../types";
import { P } from "../../types";
import { errorText, fmtStamp, t } from "../../i18n";
import { inviteLink, normalizeAddress } from "../../net/transport";
import { Field, IconButton, Icon, Modal, copyText } from "../components";
import { QrCode } from "../qr";

export function linkFor(server: ServerStore, code: string, info: InviteLinkInfo | null) {
  const n = normalizeAddress(server.saved.value.address);
  const host = info?.host || n?.host || "localhost";
  const port = info?.port ?? Number(n?.base.split(":").pop() ?? 7878);
  const fp = info?.fingerprint ?? server.saved.value.fingerprint ?? null;
  return { link: info?.tls === false ? `http://${host}:${port} (${code})` : inviteLink(host, port, code, fp), host, local: /^(localhost|127\.|::1)/.test(host) };
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
      const r = await server.rpc<{ code: string; link: InviteLinkInfo }>("invite.create", { max_uses: Number(maxUses) || null, expires_hours: Number(hours), role_id: roleId ? Number(roleId) : null });
      setCreated(r);
      void reload();
    } catch (e) {
      toast(t("invite.failed"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const copied = () => toast(t("invite.copied"), undefined, "ok", 2000);
  const shown = created ? linkFor(server, created.code, created.link) : null;
  return (
    <Modal title={t("invite.title", { name: server.displayName() })} footer={<button class="btn" onClick={closeModal}>{t("common.done")}</button>}>
      {!server.can(P.CREATE_INVITES) && <div class="notice warn">{t("invite.noPerm")}</div>}
      {shown && created && (
        <div class="col">
          <Field label={t("invite.link")}>
            <div class="row">
              <input class="input mono small" readOnly value={shown.link} onFocus={(e) => (e.target as HTMLInputElement).select()} />
              <button class="btn primary" onClick={() => { copyText(shown.link); copied(); }}>{t("common.copy")}</button>
            </div>
          </Field>
          <div class="row wrap" style={{ gap: "14px", alignItems: "center" }}>
            {!shown.local && shown.link.startsWith("domus://") && (
              <div class="qr-wrap small"><QrCode text={shown.link} size={150} label={t("invite.qr")} /></div>
            )}
            <div class="col grow" style={{ gap: "6px" }}>
              <dl class="kv">
                <dt>{t("invite.code")}</dt>
                <dd class="mono selectable">{created.code}</dd>
              </dl>
              {!shown.local && shown.link.startsWith("domus://") && <div class="faint xs">{t("invite.qrHint")}</div>}
            </div>
          </div>
          {shown.local && <div class="notice warn">{t("invite.localWarn", { host: shown.host })}</div>}
        </div>
      )}
      <div class="row wrap" style={{ gap: "10px", alignItems: "flex-end" }}>
        <Field label={t("invite.maxUses")}>
          <select class="select" value={maxUses} onChange={(e) => setMaxUses((e.target as HTMLSelectElement).value)}>
            <option value="1">1</option>
            <option value="5">5</option>
            <option value="10">10</option>
            <option value="50">50</option>
            <option value="0">{t("invite.unlimited")}</option>
          </select>
        </Field>
        <Field label={t("invite.validFor")}>
          <select class="select" value={hours} onChange={(e) => setHours((e.target as HTMLSelectElement).value)}>
            <option value="1">{t("invite.h1")}</option>
            <option value="24">{t("invite.d1")}</option>
            <option value="168">{t("invite.d7")}</option>
            <option value="720">{t("invite.d30")}</option>
            {server.can(P.MANAGE_SERVER) && <option value="0">{t("invite.unlimited")}</option>}
          </select>
        </Field>
        {canRoles && (
          <Field label={t("invite.role")}>
            <select class="select" value={roleId} onChange={(e) => setRoleId((e.target as HTMLSelectElement).value)}>
              <option value="">{t("invite.defaultRole")}</option>
              {server.roles.value.map((r) => (
                <option value={r.id} key={r.id}>{r.name}</option>
              ))}
            </select>
          </Field>
        )}
        <button class="btn primary" disabled={busy || !server.can(P.CREATE_INVITES)} onClick={() => void create()}>{t("common.create")}</button>
      </div>
      {list.length > 0 && (
        <div>
          <div class="label" style={{ marginBottom: "6px" }}>{t("invite.active")}</div>
          <table class="table">
            <thead>
              <tr><th>{t("invite.code")}</th><th>{t("invite.uses")}</th><th>{t("invite.expires")}</th><th /></tr>
            </thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.code}>
                  <td class="mono selectable">{i.code}</td>
                  <td>{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ""}</td>
                  <td>{i.expires_at ? fmtStamp(i.expires_at) : t("invite.never")}</td>
                  <td style={{ textAlign: "end" }}>
                    <IconButton title={t("invite.copyLink")} class="sm" onClick={() => { copyText(linkFor(server, i.code, linkInfo).link); copied(); }}><Icon.Copy /></IconButton>
                    <IconButton title={t("invite.revoke")} class="sm on-danger" onClick={() => server.rpc("invite.delete", { code: i.code }).then(reload, (e) => toast(t("common.error"), errorText(e), "error"))}>
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

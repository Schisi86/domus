// Create/edit channels and categories, including per-role permission overrides.

import { useEffect, useState } from "preact/hooks";
import { closeModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Category, Channel } from "../../types";
import { P } from "../../types";
import { errorText, permDesc, permName, PERMISSIONS, t } from "../../i18n";
import { Field, Modal, confirmDialog } from "../components";

interface Override {
  role_id: number;
  allow: number;
  deny: number;
}

function OverrideEditor({ server, channel }: { server: ServerStore; channel: Channel }) {
  const [list, setList] = useState<Override[]>([]);
  const [roleId, setRoleId] = useState<number | null>(null);
  const roles = server.roles.value;
  useEffect(() => {
    server.rpc<Override[]>("channel.overrides", { channel_id: channel.id }).then(setList, () => {});
  }, [channel.id]);
  const current = list.find((o) => o.role_id === roleId) ?? { role_id: roleId ?? 0, allow: 0, deny: 0 };
  const set = async (bit: number, state: "allow" | "deny" | "inherit") => {
    if (roleId === null) return;
    let { allow, deny } = current;
    allow &= ~bit;
    deny &= ~bit;
    if (state === "allow") allow |= bit;
    if (state === "deny") deny |= bit;
    try {
      const r = await server.rpc<Override>("channel.set_override", { channel_id: channel.id, role_id: roleId, allow, deny });
      setList([...list.filter((o) => o.role_id !== roleId), r]);
    } catch (e) {
      toast(t("chanDlg.permFailed"), errorText(e), "error");
    }
  };
  const textOnly = [P.SEND_MESSAGES, P.ATTACH_FILES, P.MANAGE_MESSAGES] as number[];
  const voiceOnly = [P.CONNECT, P.SPEAK, P.VIDEO, P.SCREEN_SHARE] as number[];
  const perms = PERMISSIONS.filter((p) => p.channel && (channel.kind === "voice" ? !textOnly.includes(p.bit) : !voiceOnly.includes(p.bit)));
  return (
    <div class="col">
      <div class="label">{t("chanDlg.perms")}</div>
      <div class="faint xs">{t("chanDlg.permsHint")}</div>
      <select class="select" value={roleId ?? ""} onChange={(e) => setRoleId(Number((e.target as HTMLSelectElement).value) || null)}>
        <option value="">{t("chanDlg.pickRole")}</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>{r.name}{list.some((o) => o.role_id === r.id) ? " •" : ""}</option>
        ))}
      </select>
      {roleId !== null && (
        <div class="perm-grid">
          {perms.map((p) => {
            const state = current.allow & p.bit ? "allow" : current.deny & p.bit ? "deny" : "inherit";
            return [
              <div key={`${p.bit}l`}>
                <div>{permName(p.key)}</div>
                <div class="desc">{permDesc(p.key)}</div>
              </div>,
              <div key={`${p.bit}b`} class="tabs">
                <button class={state === "deny" ? "active" : ""} onClick={() => void set(p.bit, "deny")} title={t("chanDlg.deny")}>✕</button>
                <button class={state === "inherit" ? "active" : ""} onClick={() => void set(p.bit, "inherit")} title={t("chanDlg.inherit")}>/</button>
                <button class={state === "allow" ? "active" : ""} onClick={() => void set(p.bit, "allow")} title={t("chanDlg.allow")}>✓</button>
              </div>,
            ];
          })}
        </div>
      )}
    </div>
  );
}

export function ChannelDialog({ server, channel, categoryId }: { server: ServerStore; channel?: Channel; categoryId?: number }) {
  const [kind, setKind] = useState<"text" | "voice">(channel?.kind ?? "text");
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [cat, setCat] = useState<number | null>(channel ? channel.category_id : (categoryId ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canOverrides = !!channel && server.can(P.MANAGE_ROLES);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (channel) await server.rpc("channel.update", { channel_id: channel.id, name, topic, category_id: cat });
      else await server.rpc("channel.create", { kind, name, topic, category_id: cat });
      closeModal();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!channel) return;
    if (await confirmDialog({ title: t("chan.deleteTitle"), body: t("chan.deleteBody", { name: channel.name }), confirm: t("common.delete"), danger: true })) {
      server.rpc("channel.delete", { channel_id: channel.id }).then(closeModal, (e) => toast(t("common.deleteFailed"), errorText(e), "error"));
    }
  };

  return (
    <Modal
      title={channel ? t("chanDlg.editTitle", { name: channel.name }) : t("chan.create")}
      footer={
        <>
          {channel && <button class="btn danger" style={{ marginInlineEnd: "auto" }} onClick={() => void remove()}>{t("common.delete")}</button>}
          <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
          <button class="btn primary" disabled={busy || !name.trim()} onClick={() => void save()}>{channel ? t("common.save") : t("common.create")}</button>
        </>
      }
    >
      {!channel && (
        <div class="tabs">
          <button class={kind === "text" ? "active" : ""} onClick={() => setKind("text")}># {t("chanDlg.text")}</button>
          <button class={kind === "voice" ? "active" : ""} onClick={() => setKind("voice")}>🔊 {t("chanDlg.voice")}</button>
        </div>
      )}
      <Field label={t("common.name")} error={error}>
        <input class="input" autoFocus value={name} maxLength={64} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </Field>
      {kind === "text" && (
        <Field label={t("chanDlg.topic")}>
          <input class="input" value={topic} maxLength={256} onInput={(e) => setTopic((e.target as HTMLInputElement).value)} />
        </Field>
      )}
      <Field label={t("chanDlg.category")}>
        <select class="select" value={cat ?? ""} onChange={(e) => setCat(Number((e.target as HTMLSelectElement).value) || null)}>
          <option value="">{t("common.none")}</option>
          {server.categories.value.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>
      {canOverrides && channel && <OverrideEditor server={server} channel={channel} />}
    </Modal>
  );
}

export function CategoryDialog({ server, category }: { server: ServerStore; category?: Category }) {
  const [name, setName] = useState(category?.name ?? "");
  const [position, setPosition] = useState(String(category?.position ?? 0));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      if (category) await server.rpc("category.update", { category_id: category.id, name, position: Number(position) || 0 });
      else await server.rpc("category.create", { name });
      closeModal();
    } catch (e) {
      setError(errorText(e));
    }
  };
  return (
    <Modal
      title={category ? t("cat.edit") : t("cat.create")}
      footer={
        <>
          <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
          <button class="btn primary" disabled={!name.trim()} onClick={() => void save()}>{t("common.save")}</button>
        </>
      }
    >
      <Field label={t("common.name")} error={error}>
        <input class="input" autoFocus value={name} maxLength={64} onInput={(e) => setName((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
      </Field>
      {category && (
        <Field label={t("cat.position")} hint={t("cat.positionHint")}>
          <input class="input" type="number" min={0} value={position} onInput={(e) => setPosition((e.target as HTMLInputElement).value)} />
        </Field>
      )}
    </Modal>
  );
}

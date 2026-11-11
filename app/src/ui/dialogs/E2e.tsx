// End-to-end encryption of a direct message: switch, security number, key
// backup – and a plain statement of what it does and does not protect.

import { useEffect, useState } from "preact/hooks";
import { closeModal, settings, toast, updateSettings } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { Dm } from "../../types";
import { t } from "../../i18n";
import { pickFiles, saveBlob } from "../../platform";
import { Icon, Modal, Spinner, Toggle, copyText, promptDialog } from "../components";

/** Remembers the peer's current key as "seen" (clears the key-change warning). */
export function markKeySeen(server: ServerStore, uid: number) {
  const kid = server.e2e.peerKids.value.get(uid);
  if (kid) updateSettings({ e2eSeen: { ...settings.value.e2eSeen, [`${server.id}:${uid}`]: kid } });
}

/** True if the peer's key differs from the one this device has seen before. */
export function keyChanged(server: ServerStore, uid: number): boolean {
  const seen = settings.value.e2eSeen[`${server.id}:${uid}`];
  const cur = server.e2e.peerKids.value.get(uid);
  return !!seen && !!cur && seen !== cur;
}

export function E2eDialog({ server, dm }: { server: ServerStore; dm: Dm }) {
  const on = server.e2eOn(dm.channel_id);
  const self = dm.user_id === server.me.value?.id;
  const name = server.dmName(dm.user_id);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const peerKid = self ? server.e2e.myKid.value : server.e2e.peerKids.value.get(dm.user_id);
  const number = server.e2e.safetyNumber(dm.user_id);
  const changed = !self && keyChanged(server, dm.user_id);

  useEffect(() => {
    void Promise.all([server.e2e.ensureKey(), server.e2e.fetchKeys(dm.user_id, true)])
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = (x: boolean) => {
    server.setE2e(dm.channel_id, x);
    if (x && !self) markKeySeen(server, dm.user_id);
  };
  const backup = async () => {
    const pass = await promptDialog({ title: t("e2e.backupTitle"), label: t("e2e.passphrase"), body: t("e2e.backupBody"), password: true, confirm: t("e2e.backup") });
    if (!pass) return;
    if (pass.length < 8) return toast(t("e2e.passShort"), undefined, "warn");
    setBusy(true);
    try {
      const data = await server.e2e.exportKeys(pass);
      if (await saveBlob(`nexus-schluessel-${server.me.value?.username ?? "konto"}.json`, new Blob([data], { type: "application/json" }))) toast(t("e2e.backupDone"), undefined, "ok");
    } catch (e) {
      toast(t("e2e.backupFailed"), String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    const [file] = await pickFiles(".json,application/json", false);
    if (!file) return;
    const pass = await promptDialog({ title: t("e2e.restoreTitle"), label: t("e2e.passphrase"), body: t("e2e.restoreBody"), password: true, confirm: t("e2e.restore") });
    if (!pass) return;
    setBusy(true);
    try {
      await server.e2e.importKeys(pass, await file.text());
      toast(t("e2e.restoreDone"), t("e2e.restoreDoneBody"), "ok", 7000);
    } catch {
      toast(t("e2e.restoreFailed"), t("e2e.restoreFailedBody"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t("e2e.title")} sub={name} footer={<button class="btn" onClick={closeModal}>{t("common.close")}</button>}>
      {loading ? (
        <Spinner />
      ) : (
        <>
          <div class={`e2e-state${on ? " on" : ""}`}>
            {on ? <Icon.Lock size={22} /> : <Icon.Unlock size={22} />}
            <div class="grow">
              <b>{on ? t("e2e.stateOn") : t("e2e.stateOff")}</b>
              <div class="faint xs">{on ? t("e2e.stateOnDesc") : t("e2e.stateOffDesc")}</div>
            </div>
          </div>
          {!peerKid && <div class="notice warn">{t("e2e.peerNoKey", { name })}</div>}
          <Toggle checked={on} disabled={!peerKid} onChange={toggle} label={t("e2e.enable")} desc={t("e2e.enableDesc", { name })} />
          {changed && (
            <div class="notice danger">
              {t("e2e.keyChanged", { name })}
              <div style={{ marginTop: "8px" }}>
                <button class="btn sm" onClick={() => markKeySeen(server, dm.user_id)}>{t("e2e.keyChangedOk")}</button>
              </div>
            </div>
          )}
          {number && (
            <div class="card col" style={{ gap: "6px" }}>
              <div class="label">{t("e2e.number")}</div>
              <div class="e2e-number mono" onClick={() => { copyText(number); toast(t("common.copied"), undefined, "ok", 1500); }} title={t("common.copy")}>{number}</div>
              <div class="faint xs">{self ? t("e2e.numberSelf") : t("e2e.numberHint", { name })}</div>
            </div>
          )}
          <div class="card col" style={{ gap: "8px" }}>
            <div class="label">{t("e2e.keys")}</div>
            <div class="faint xs">{t("e2e.keysHint")}</div>
            <div class="row" style={{ gap: "8px", flexWrap: "wrap" }}>
              <button class="btn outline sm" disabled={busy} onClick={() => void backup()}><Icon.Download size={14} /> {t("e2e.backup")}</button>
              <button class="btn outline sm" disabled={busy} onClick={() => void restore()}><Icon.Upload size={14} /> {t("e2e.restore")}</button>
            </div>
          </div>
          <ul class="e2e-limits faint xs">
            <li>{t("e2e.limit1")}</li>
            <li>{t("e2e.limit2")}</li>
            <li>{t("e2e.limit3")}</li>
            <li>{t("e2e.limit4")}</li>
          </ul>
        </>
      )}
    </Modal>
  );
}

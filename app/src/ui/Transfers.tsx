// Direct file transfers: the floating list with progress, and the entry point
// "send a file directly" (no server upload, no size limit).

import { toast } from "../state/app";
import type { ServerStore } from "../state/server";
import { fmtBytes, t } from "../i18n";
import { pickFiles } from "../platform";
import { acceptTransfer, cancelTransfer, declineTransfer, dismissTransfer, offerFile, transferActive, transfers, type Transfer } from "../rtc/transfer";
import { Icon, IconButton, ProgressBar } from "./components";

/** Lets the user pick files and offers each one directly to `uid`. */
export async function sendDirect(server: ServerStore, uid: number, files?: File[]) {
  const member = server.member(uid);
  if (member && member.presence === "offline") {
    toast(t("xfer.offline", { name: server.memberName(uid) }), t("xfer.offlineBody"), "warn");
    return;
  }
  const list = files ?? (await pickFiles());
  for (const f of list.slice(0, 10)) await offerFile(server, uid, f);
}

function eta(tr: Transfer) {
  if (!tr.speed || tr.done >= tr.size) return "";
  const s = Math.round((tr.size - tr.done) / tr.speed);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

function status(tr: Transfer): string {
  switch (tr.state) {
    case "offered":
      return t("xfer.offered", { size: fmtBytes(tr.size) });
    case "waiting":
      return t("xfer.waiting");
    case "connecting":
      return t("xfer.connecting");
    case "active":
      return `${fmtBytes(tr.done)} / ${fmtBytes(tr.size)} · ${fmtBytes(tr.speed)}/s${eta(tr) ? ` · ${eta(tr)}` : ""}`;
    case "done":
      return t("xfer.done", { size: fmtBytes(tr.size) });
    case "declined":
      return t("xfer.declined");
    case "cancelled":
      return t("xfer.cancelled");
    default:
      return tr.error || t("xfer.failed");
  }
}

function Card({ tr }: { tr: Transfer }) {
  const who = tr.server.memberName(tr.peer);
  const active = transferActive(tr);
  return (
    <div class={`xfer-card ${tr.state}`}>
      <div class="xfer-icon">{tr.dir === "send" ? <Icon.Upload size={17} /> : <Icon.Download size={17} />}</div>
      <div class="xfer-main">
        <div class="xfer-name ellipsis" title={tr.name}>{tr.name}</div>
        <div class="xfer-sub ellipsis">{tr.dir === "send" ? t("xfer.to", { name: who }) : t("xfer.from", { name: who })} · {status(tr)}</div>
        {(tr.state === "active" || tr.state === "connecting") && <ProgressBar value={tr.size ? tr.done / tr.size : tr.state === "active" ? 1 : 0} />}
      </div>
      {tr.state === "offered" ? (
        <div class="xfer-actions">
          <button class="btn sm primary" onClick={() => void acceptTransfer(tr.id)}>{t("xfer.accept")}</button>
          <button class="btn sm ghost" onClick={() => declineTransfer(tr.id)}>{t("xfer.decline")}</button>
        </div>
      ) : (
        <IconButton title={active ? t("common.cancel") : t("common.close")} class="sm" onClick={() => (active ? cancelTransfer(tr.id) : dismissTransfer(tr.id))}>
          <Icon.X />
        </IconButton>
      )}
    </div>
  );
}

/** Floating list of running, offered and finished direct transfers. */
export function TransfersPanel() {
  const list = transfers.value;
  if (!list.length) return null;
  return (
    <div class="xfer-panel" role="region" aria-label={t("xfer.title")}>
      <div class="xfer-head">
        <Icon.Zap size={14} /> {t("xfer.title")}
        <span class="grow" />
        {list.some((x) => !transferActive(x)) && (
          <button class="link-btn xs" onClick={() => list.filter((x) => !transferActive(x)).forEach((x) => dismissTransfer(x.id))}>{t("xfer.clear")}</button>
        )}
      </div>
      {list.map((tr) => (
        <Card key={tr.id} tr={tr} />
      ))}
    </div>
  );
}

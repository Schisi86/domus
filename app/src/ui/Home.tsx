// Home screen: welcome (no servers yet) or friends across all connected servers.

import { NavBack } from "./mobile";
import { useState } from "preact/hooks";
import { openModal, servers, startDm, toast } from "../state/app";
import type { ServerStore } from "../state/server";
import type { RelKind } from "../types";
import { errorText, presenceText, t } from "../i18n";
import { Avatar, EmptyState, IconButton, Icon, LogoMark } from "./components";
import { AddServerDialog } from "./dialogs/AddServer";
import { HostDialog } from "./dialogs/Host";
import { TransferDialog } from "./dialogs/Transfer";
import { isIOSApp, isMobileApp } from "../platform";

type Tab = "online" | "all" | "pending" | "blocked";

export function FriendsView() {
  const [tab, setTab] = useState<Tab>("online");
  if (!servers.value.length) {
    return (
      <EmptyState title={t("home.welcome")} icon={<LogoMark size={110} />}>
        <p class="muted">{t("home.welcomeText")}</p>
        <div class="row wrap center welcome-actions">
          <button class="btn primary lg" onClick={() => openModal(<AddServerDialog />)}><Icon.Plus /> {t("rail.add")}</button>
          <button class={`btn lg${isMobileApp ? " primary" : ""}`} onClick={() => openModal(<TransferDialog mode="receive" />)}><Icon.Qr /> {t("move.fromOther")}</button>
          {!isIOSApp && <button class="btn lg" onClick={() => openModal(<HostDialog />)}><Icon.ServerIcon /> {t("home.startOwn")}</button>}
        </div>
      </EmptyState>
    );
  }
  const rows: { s: ServerStore; uid: number; kind: RelKind }[] = [];
  for (const s of servers.value) for (const [uid, kind] of s.relationships.value) rows.push({ s, uid, kind });
  const filtered = rows.filter(({ s, uid, kind }) => {
    if (tab === "pending") return kind === "incoming" || kind === "outgoing";
    if (tab === "blocked") return kind === "blocked";
    if (kind !== "friend") return false;
    return tab === "all" || (s.member(uid)?.presence ?? "offline") !== "offline";
  });
  const run = (s: ServerStore, op: string, uid: number) => s.rpc(op, { user_id: uid }).catch((e) => toast(t("common.actionFailed"), errorText(e), "error"));
  const labels: Record<Tab, string> = { online: t("friends.online"), all: t("friends.all"), pending: t("friends.pending"), blocked: t("friends.blocked") };
  return (
    <div class="content">
      <header class="main-head">
        <NavBack />
        <div class="chan-title"><Icon.Mail /> {t("home.friends")}</div>
        <div class="tabs">
          {(["online", "all", "pending", "blocked"] as Tab[]).map((x) => (
            <button key={x} class={tab === x ? "active" : ""} onClick={() => setTab(x)}>{labels[x]}</button>
          ))}
        </div>
      </header>
      <div class="messages" style={{ padding: "16px" }}>
        {!filtered.length && (
          <div class="faint" style={{ padding: "20px", textAlign: "center" }}>
            {tab === "pending" ? t("friends.noPending") : tab === "blocked" ? t("friends.noBlocked") : t("friends.empty")}
          </div>
        )}
        {filtered.map(({ s, uid, kind }) => {
          const m = s.member(uid);
          return (
            <div class="list-item" key={`${s.id}:${uid}`}>
              <Avatar server={s} userId={uid} name={s.memberName(uid)} size={36} presence={m?.presence ?? "offline"} />
              <div class="grow" style={{ minWidth: "0px" }}>
                <div class="ellipsis"><b>{s.memberName(uid)}</b> <span class="faint small">@{m?.username}</span></div>
                <div class="faint xs ellipsis">
                  {kind === "incoming" ? t("friends.incoming") : kind === "outgoing" ? t("friends.outgoing") : kind === "blocked" ? t("friends.blockedOne") : m?.status_text || presenceText(m?.presence ?? "offline")}
                  {servers.value.length > 1 && ` · ${s.displayName()}`}
                </div>
              </div>
              {kind === "friend" && <IconButton title={t("member.message")} onClick={() => void startDm(s, uid).catch((e) => toast(t("common.error"), errorText(e), "error"))}><Icon.Chat /></IconButton>}
              {kind === "incoming" && <IconButton title={t("friends.accept")} onClick={() => run(s, "relationship.request", uid)}><Icon.Check /></IconButton>}
              {(kind === "incoming" || kind === "outgoing" || kind === "friend") && (
                <IconButton title={kind === "friend" ? t("member.removeFriend") : t("friends.decline")} onClick={() => run(s, "relationship.remove", uid)}><Icon.X /></IconButton>
              )}
              {kind === "blocked" && <button class="btn sm" onClick={() => run(s, "relationship.unblock", uid)}>{t("member.unblock")}</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

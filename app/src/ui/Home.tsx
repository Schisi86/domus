// Home screen: friends and requests across all connected servers.

import { useState } from "preact/hooks";
import { openModal, servers, startDm, toast } from "../state/app";
import type { ServerStore } from "../state/server";
import type { RelKind } from "../types";
import { errorText, PRESENCE_TEXT } from "../i18n";
import { Avatar, EmptyState, IconButton, Icon } from "./components";
import { AddServerDialog } from "./dialogs/AddServer";
import { HostDialog } from "./dialogs/Host";

type Tab = "online" | "all" | "pending" | "blocked";

export function FriendsView() {
  const [tab, setTab] = useState<Tab>("online");
  if (!servers.value.length) {
    return (
      <EmptyState title="Willkommen bei NexusTalk">
        <p class="muted">Verbinde dich mit einem bestehenden Server oder betreibe deinen eigenen – ganz ohne Cloud-Dienst.</p>
        <div class="row">
          <button class="btn primary" onClick={() => openModal(<AddServerDialog />)}>Server hinzufügen</button>
          <button class="btn outline" onClick={() => openModal(<HostDialog />)}>Eigenen Server starten</button>
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
  const run = (s: ServerStore, op: string, uid: number) => s.rpc(op, { user_id: uid }).catch((e) => toast("Aktion fehlgeschlagen", errorText(e), "error"));
  return (
    <div class="content">
      <header class="main-head">
        <div class="chan-title"><Icon.Users /> Freunde</div>
        <div class="tabs">
          {(["online", "all", "pending", "blocked"] as Tab[]).map((t) => (
            <button key={t} class={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {{ online: "Online", all: "Alle", pending: "Ausstehend", blocked: "Blockiert" }[t]}
            </button>
          ))}
        </div>
      </header>
      <div class="messages" style={{ padding: "16px" }}>
        {!filtered.length && (
          <div class="faint" style={{ padding: "20px", textAlign: "center" }}>
            {tab === "pending" ? "Keine offenen Anfragen." : tab === "blocked" ? "Niemand blockiert." : "Hier erscheinen deine Freunde. Füge Personen über ihr Profil in der Mitgliederliste hinzu."}
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
                  {kind === "incoming" ? "Eingehende Anfrage" : kind === "outgoing" ? "Ausgehende Anfrage" : kind === "blocked" ? "Blockiert" : m?.status_text || PRESENCE_TEXT[m?.presence ?? "offline"]}
                  {servers.value.length > 1 && ` · ${s.displayName()}`}
                </div>
              </div>
              {kind === "friend" && (
                <IconButton title="Nachricht" onClick={() => void startDm(s, uid).catch((e) => toast("Fehler", errorText(e), "error"))}><Icon.Chat /></IconButton>
              )}
              {kind === "incoming" && <IconButton title="Annehmen" onClick={() => run(s, "relationship.request", uid)}><Icon.Check /></IconButton>}
              {(kind === "incoming" || kind === "outgoing" || kind === "friend") && (
                <IconButton title={kind === "friend" ? "Freund entfernen" : "Ablehnen"} onClick={() => run(s, "relationship.remove", uid)}><Icon.X /></IconButton>
              )}
              {kind === "blocked" && <button class="btn sm" onClick={() => run(s, "relationship.unblock", uid)}>Entblocken</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Ctrl+K: jump to any channel, DM or member across all servers.
// Ctrl+/: keyboard shortcut overview.

import { MOD_KEY } from "../platform";
import { useMemo, useState } from "preact/hooks";
import { closeModal, openDm, selectChannel, selectServer, servers, startDm, toast } from "../state/app";
import type { ServerStore } from "../state/server";
import { errorText, t } from "../i18n";
import { Avatar, Modal, Icon } from "./components";
import { joinVoice } from "../rtc/voice";

interface Entry {
  key: string;
  label: string;
  sub: string;
  icon: preact.ComponentChild;
  run: () => void;
}

function entries(): Entry[] {
  const out: Entry[] = [];
  const multi = servers.value.length > 1;
  for (const s of servers.value) {
    for (const c of s.channels.value) {
      out.push({
        key: `c${s.id}${c.id}`,
        label: c.name,
        sub: s.displayName(),
        icon: c.kind === "voice" ? <Icon.Speaker /> : <Icon.Hash />,
        run: () => {
          selectServer(s.id);
          selectChannel(c.id);
          if (c.kind === "voice") void joinVoice(s, c.id);
        },
      });
    }
    for (const d of s.dms.value) {
      out.push({
        key: `d${s.id}${d.channel_id}`,
        label: s.memberName(d.user_id),
        sub: multi ? `${t("switcher.dm")} · ${s.displayName()}` : t("switcher.dm"),
        icon: <Avatar server={s} userId={d.user_id} name={s.memberName(d.user_id)} size={20} />,
        run: () => openDm(s, d.channel_id),
      });
    }
    const me = s.me.value?.id;
    for (const m of s.members.value.values()) {
      if (m.id === me || s.dms.value.some((d) => d.user_id === m.id)) continue;
      out.push({
        key: `m${s.id}${m.id}`,
        label: m.display_name || m.username,
        sub: `@${m.username}${multi ? ` · ${s.displayName()}` : ""}`,
        icon: <Avatar server={s as ServerStore} userId={m.id} name={m.display_name || m.username} size={20} />,
        run: () => void startDm(s, m.id).catch((e) => toast(t("common.error"), errorText(e), "error")),
      });
    }
  }
  return out;
}

export function QuickSwitcher() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const all = useMemo(entries, []);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    const res = n ? all.filter((e) => e.label.toLowerCase().includes(n) || e.sub.toLowerCase().includes(n)) : all;
    return res.slice(0, 40);
  }, [q, all]);
  const go = (e?: Entry) => {
    if (!e) return;
    closeModal();
    e.run();
  };
  return (
    <div class="overlay" onMouseDown={(e) => e.target === e.currentTarget && closeModal()}>
      <div class="modal switcher" role="dialog" aria-label={t("switcher.title")}>
        <input
          class="input"
          autoFocus
          placeholder={t("switcher.placeholder")}
          value={q}
          onInput={(e) => {
            setQ((e.target as HTMLInputElement).value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") closeModal();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((sel + 1) % Math.max(1, list.length));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((sel - 1 + list.length) % Math.max(1, list.length));
            }
            if (e.key === "Enter") go(list[sel]);
          }}
        />
        <div class="switcher-list">
          {list.map((e, i) => (
            <button key={e.key} class={i === sel ? "sel" : ""} onMouseEnter={() => setSel(i)} onClick={() => go(e)}>
              {e.icon}
              <span class="grow ellipsis">{e.label}</span>
              <span class="faint xs ellipsis">{e.sub}</span>
            </button>
          ))}
          {!list.length && <div class="faint small" style={{ padding: "10px" }}>{t("switcher.empty")}</div>}
        </div>
        <div class="faint xs" style={{ marginTop: "8px" }}>
          <kbd>↑</kbd> <kbd>↓</kbd> {t("switcher.navigate")} · <kbd>Enter</kbd> {t("switcher.open")} · <kbd>Esc</kbd> {t("common.close")}
        </div>
      </div>
    </div>
  );
}

export function ShortcutsDialog() {
  const rows: [string, string][] = [
    [`${MOD_KEY} + K`, t("keys.switcher")],
    ["Alt + ↑ / ↓", t("keys.channelNav")],
    [`${MOD_KEY} + /`, t("keys.help")],
    ["Enter", t("keys.send")],
    ["Shift + Enter", t("keys.newline")],
    ["↑", t("keys.editLast")],
    [`${MOD_KEY} + B / I / U`, t("keys.format")],
    ["Esc", t("keys.cancel")],
    [`${MOD_KEY} + Shift + M`, t("keys.mute")],
    [`${MOD_KEY} + Shift + D`, t("keys.deafen")],
  ];
  return (
    <Modal title={t("keys.title")} footer={<button class="btn" onClick={closeModal}>{t("common.close")}</button>}>
      <table class="table">
        <tbody>
          {rows.map(([k, d]) => (
            <tr key={k}>
              <td style={{ width: "40%" }}>{k.split(" ").map((p, i) => (p === "+" || p === "/" ? ` ${p} ` : <kbd key={i}>{p}</kbd>))}</td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

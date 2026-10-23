// Root layout: server rail | floating shell (sidebar, main content, member list).

import { useEffect } from "preact/hooks";
import { activeChannelId, activeServer, activeServerId, contextMenu, dialog, homeDm, modal, openChannel, openModal, selectChannel, settings } from "../state/app";
import { ContextMenu, EmptyState, Lightbox, Toasts } from "./components";
import { Rail } from "./Rail";
import { Sidebar } from "./Sidebar";
import { ChatView } from "./Chat";
import { MemberList } from "./Members";
import { VoiceView } from "./VoiceView";
import { FriendsView } from "./Home";
import { voice } from "../rtc/voice";
import { lang, t } from "../i18n";
import { applyTheme } from "../themes";
import { isTauri, tauriInvoke } from "../platform";
import { QuickSwitcher, ShortcutsDialog } from "./QuickSwitcher";

function useAppearance() {
  const s = settings.value;
  useEffect(() => {
    document.documentElement.style.setProperty("--scale", String(s.scale));
  }, [s.scale]);
  useEffect(() => {
    if (!s.followSystemTheme) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const f = () => applyTheme(s.theme, true);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, [s.followSystemTheme, s.theme]);
  // Keep the tray menu in the UI language.
  useEffect(() => {
    if (isTauri) void tauriInvoke("set_tray_labels", { open: t("tray.open"), quit: t("tray.quit") }).catch(() => {});
  }, [lang.value]);
}

function useShortcuts() {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openModal(<QuickSwitcher />);
      } else if (ctrl && e.key === "/") {
        e.preventDefault();
        openModal(<ShortcutsDialog />);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "m") {
        e.preventDefault();
        const v = voice.value;
        if (v?.hasMic.value) void v.setMuted(!v.muted.value);
      } else if (ctrl && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const v = voice.value;
        if (v) void v.setDeafened(!v.deafened.value);
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        const s = activeServer.value;
        if (!s) return;
        e.preventDefault();
        const list = s.channels.value.filter((c) => c.kind === "text").sort((a, b) => (a.category_id ?? -1) - (b.category_id ?? -1) || a.position - b.position);
        const i = list.findIndex((c) => c.id === activeChannelId.value);
        const next = list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length];
        if (next) selectChannel(next.id);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
}

function Main() {
  const server = activeServer.value;
  const open = openChannel.value;
  if (activeServerId.value === null) {
    if (homeDm.value && open) return <ChatView key={`${open.server.id}:${open.channelId}`} server={open.server} channelId={open.channelId} />;
    return <FriendsView />;
  }
  if (!server) return <EmptyState title={t("app.serverNotFound")} />;
  if (!open) {
    return (
      <EmptyState title={server.displayName()}>
        <p class="muted">{server.conn.state.value === "ready" ? t("app.pickChannel") : t("app.connecting")}</p>
      </EmptyState>
    );
  }
  const ch = server.channel(open.channelId);
  if (ch?.kind === "voice") return <VoiceView key={`${server.id}:${ch.id}`} server={server} channel={ch} />;
  return (
    <div class="main-body">
      <ChatView key={`${server.id}:${open.channelId}`} server={server} channelId={open.channelId} />
      {settings.value.showMembers && <MemberList server={server} channelId={open.channelId} />}
    </div>
  );
}

export function App() {
  useAppearance();
  useShortcuts();
  void voice.value;
  void lang.value;
  return (
    <div
      class="app"
      onContextMenu={(e) => {
        // Native context menu only inside editable/selectable text.
        const tg = e.target as HTMLElement;
        if (!tg.closest("input, textarea, .selectable, .msg-text")) e.preventDefault();
      }}
    >
      <Rail />
      <div class="shell">
        <Sidebar />
        <main class="main" aria-label={t("app.content")}>
          <Main />
        </main>
      </div>
      {modal.value}
      {dialog.value}
      {contextMenu.value && <ContextMenu />}
      <Lightbox />
      <Toasts />
    </div>
  );
}

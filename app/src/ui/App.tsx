// Root layout: server rail | sidebar | main content | member list.

import { useEffect } from "preact/hooks";
import { activeServer, activeServerId, contextMenu, homeDm, modal, openChannel, settings } from "../state/app";
import { ContextMenu, EmptyState, Lightbox, Toasts } from "./components";
import { Rail } from "./Rail";
import { Sidebar } from "./Sidebar";
import { ChatView } from "./Chat";
import { MemberList } from "./Members";
import { VoiceView } from "./VoiceView";
import { FriendsView } from "./Home";
import { voice } from "../rtc/voice";

function useTheme() {
  const s = settings.value;
  useEffect(() => {
    const apply = () => {
      const dark = s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
    };
    apply();
    document.documentElement.style.setProperty("--scale", String(s.scale));
    if (s.theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [s.theme, s.scale]);
}

function Main() {
  const server = activeServer.value;
  const open = openChannel.value;
  if (activeServerId.value === null) {
    if (homeDm.value && open) return <ChatView key={`${open.server.id}:${open.channelId}`} server={open.server} channelId={open.channelId} />;
    return <FriendsView />;
  }
  if (!server) return <EmptyState title="Server nicht gefunden" />;
  if (!open) {
    return (
      <EmptyState title={server.displayName()}>
        <p class="muted">{server.conn.state.value === "ready" ? "Wähle links einen Kanal aus." : "Verbindung wird aufgebaut …"}</p>
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
  useTheme();
  // Make sure the active voice session object is referenced so its signals re-render.
  void voice.value;
  return (
    <div class="app" onContextMenu={(e) => {
      // Native context menu only inside editable/selectable text.
      const t = e.target as HTMLElement;
      if (!t.closest("input, textarea, .selectable, .msg-text")) e.preventDefault();
    }}>
      <Rail />
      <Sidebar />
      <main class="main" aria-label="Inhalt">
        <Main />
      </main>
      {modal.value}
      {contextMenu.value && <ContextMenu />}
      <Lightbox />
      <Toasts />
    </div>
  );
}

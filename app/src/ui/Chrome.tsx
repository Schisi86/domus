// Window chrome: a title bar drawn in the colours of the active design
// (instead of the native Windows bar) and a quiet footer with credits,
// donation link and the language flag.

import { useEffect, useState } from "preact/hooks";
import { activeServer, activeServerId, homeDm, openChannel } from "../state/app";
import { t } from "../i18n";
import { isTauri } from "../platform";
import { COPYRIGHT, DONATE_URL, HOMEPAGE } from "../brand";
import { openExternal } from "./links";
import { LangPicker } from "./LangPicker";

type Win = Awaited<ReturnType<typeof getWin>>;
async function getWin() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

function useWindow() {
  const [win, setWin] = useState<Win | null>(null);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let off: (() => void) | undefined;
    void getWin().then(async (w) => {
      setWin(w);
      setMaximized(await w.isMaximized());
      off = await w.onResized(async () => setMaximized(await w.isMaximized()));
    });
    return () => off?.();
  }, []);
  return { win, maximized };
}

/** Where the user is – shown in the middle of the title bar, like Discord. */
function contextTitle() {
  const s = activeServer.value;
  if (activeServerId.value === null) {
    const open = homeDm.value ? openChannel.value : null;
    const dm = open?.server.dm(open.channelId);
    return dm ? `@ ${open!.server.memberName(dm.user_id)}` : t("home.dms");
  }
  if (!s) return "";
  const ch = openChannel.value ? s.channel(openChannel.value.channelId) : undefined;
  return ch ? `${s.displayName()}  ·  ${ch.kind === "voice" ? "🔊 " : "# "}${ch.name}` : s.displayName();
}

export function TitleBar() {
  // Only the desktop app has a window to control (the browser build has none).
  return isTauri ? <DesktopTitleBar /> : null;
}

function DesktopTitleBar() {
  const { win, maximized } = useWindow();
  return (
    <header class="titlebar" data-tauri-drag-region>
      <div class="tb-brand" data-tauri-drag-region>
        <img src="/icon.png" alt="" draggable={false} />
        <span data-tauri-drag-region class="wordmark">Dom<b>us</b></span>
      </div>
      <div class="tb-title ellipsis" data-tauri-drag-region>{contextTitle()}</div>
      <div class="tb-controls">
        <button class="tb-btn" title={t("tb.minimize")} aria-label={t("tb.minimize")} onClick={() => void win?.minimize()}>
          <svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1" /></svg>
        </button>
        <button class="tb-btn" title={maximized ? t("tb.restore") : t("tb.maximize")} aria-label={maximized ? t("tb.restore") : t("tb.maximize")} onClick={() => void win?.toggleMaximize()}>
          {maximized ? (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"><path d="M2.5 2.5V.5h7v7h-2" /><rect x=".5" y="2.5" width="7" height="7" /></svg>
          ) : (
            <svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"><rect x=".5" y=".5" width="9" height="9" /></svg>
          )}
        </button>
        <button class="tb-btn close" title={t("tb.close")} aria-label={t("tb.close")} onClick={() => void win?.close()}>
          <svg viewBox="0 0 10 10" width="10" height="10" stroke="currentColor" stroke-width="1.1"><path d="M.5.5l9 9M9.5.5l-9 9" /></svg>
        </button>
      </div>
    </header>
  );
}

export function Footer() {
  const link = (url: string) => (e: MouseEvent) => {
    e.preventDefault();
    void openExternal(url, true);
  };
  return (
    <footer class="app-foot">
      <span class="grow" />
      <a href={DONATE_URL} onClick={link(DONATE_URL)} title={t("about.donateText")}>{t("foot.donate")}</a>
      <span class="sep">·</span>
      <a href={HOMEPAGE} onClick={link(HOMEPAGE)} title={HOMEPAGE.replace("https://", "")}>{COPYRIGHT}</a>
      <LangPicker class="foot-flag" />
    </footer>
  );
}

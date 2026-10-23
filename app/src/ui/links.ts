// Opening external links (system browser in the desktop app).

import { t } from "../i18n";
import { isTauri } from "../platform";
import { confirmDialog } from "./components";

/** Opens an http(s) URL outside the app. Unknown links ask first; `trusted` skips the question. */
export async function openExternal(url: string, trusted = false) {
  if (!/^https?:\/\//i.test(url)) return;
  if (!trusted && !(await confirmDialog({ title: t("link.title"), body: url, confirm: t("link.open") }))) return;
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else window.open(url, "_blank", "noopener,noreferrer");
}

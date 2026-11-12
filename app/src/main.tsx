import { render } from "preact";
import "./styles.css";
import { App } from "./ui/App";
import { initApp } from "./state/app";
import { startHostPolling } from "./state/hosting";
import { isMobile, isTauri, log } from "./platform";
import { initBackKey } from "./ui/mobile";
import { voice } from "./rtc/voice";
import { servers, settings, startDm, updateSettings } from "./state/app";
import { acceptTransfer, offerFile, transfers } from "./rtc/transfer";
import { playFileForAll } from "./rtc/watch";
import { inkTool } from "./rtc/ink";

// Inspection hook for automated browser tests (not present in the desktop app).
if (!isTauri) (window as unknown as Record<string, unknown>).__nexus = { voice, servers, updateSettings, settings, transfers, offerFile, acceptTransfer, playFileForAll, inkTool, startDm };

window.addEventListener("error", (e) => log("error", `${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  // Expected server/network errors are handled where they occur.
  if (r && typeof r === "object" && ("code" in r || "kind" in r)) return;
  log("error", `unhandled rejection: ${r instanceof Error ? r.stack ?? r.message : String(r)}`);
});

void initApp().finally(() => {
  render(<App />, document.getElementById("app")!);
  if (isMobile) initBackKey();
  startHostPolling();
  log("info", "ui ready");
});

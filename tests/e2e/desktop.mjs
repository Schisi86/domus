// Drives the real desktop app (WebView2) through the DevTools protocol.
//
//   set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
//   target\release\nexustalk.exe
//   node tests/e2e/desktop.mjs
//
// Checks the embedded server mode end to end: start server, create owner via
// the Rust networking layer (TLS + certificate pinning), chat, voice join with
// the real microphone permission handler, and the availability of screen capture.

import { writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const shots = join(ROOT, "docs", "screenshots");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages().find((p) => p.url().includes("tauri.localhost"));
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.setViewportSize?.({ width: 1280, height: 800 }).catch(() => {});

try {
  await page.waitForSelector(".rail", { timeout: 15000 });
  check("app UI loaded in WebView2", true, await page.evaluate(() => navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] ?? ""));
  await page.screenshot({ path: join(shots, "01-welcome.png") });

  // Server mode (close leftovers from an earlier run first)
  await page.keyboard.press("Escape");
  await page.click('button[aria-label="Eigenen Server betreiben"]');
  await page.waitForSelector("text=Eigenen Server betreiben");
  await page.screenshot({ path: join(shots, "02-host-dialog.png") });
  const exposedDefault = await page.locator('input[name="exp"]').first().isChecked();
  check("server mode defaults to 'Nur dieser PC'", exposedDefault);
  await page.click(".pane-nav button:has-text('Server starten')");
  await page.waitForSelector("text=Serverinhaber anlegen", { timeout: 20000 });
  const fp = await page.locator(".mono.xs.selectable").first().innerText();
  check("embedded server started with TLS", /^[0-9A-F]{64}$/.test(fp.trim()), fp.trim().slice(0, 16) + "…");
  await page.fill('input[placeholder="Benutzername"]', "owner");
  await page.fill('input[placeholder="Passwort (min. 8 Zeichen)"]', "testpass123");
  await page.click("button:has-text('Anlegen')");
  await page.waitForSelector(".chan .name", { timeout: 20000 });
  check("owner created and connected via pinned TLS", true);
  await page.locator(".chan", { hasText: "allgemein" }).first().click();
  await page.fill(".composer textarea", "Erste Nachricht aus der Desktop-App 👋");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".msg-text:has-text('Erste Nachricht')", { timeout: 10000 });
  check("message sent and displayed", true);
  await sleep(500);
  await page.screenshot({ path: join(shots, "03-chat.png") });

  // Settings & admin dialogs render
  await page.click('button[title="Einstellungen"]');
  await page.waitForSelector("text=Mein Konto");
  await page.click("button:has-text('Sprache & Video')");
  await sleep(500);
  await page.screenshot({ path: join(shots, "05-settings-voice.png") });
  await page.keyboard.press("Escape");
  await page.click(".sidebar-head");
  await page.click(".menu button:has-text('Servereinstellungen')");
  await page.waitForSelector("text=Registrierung");
  await sleep(500);
  await page.screenshot({ path: join(shots, "06-server-settings.png") });
  check("settings and server administration dialogs open", true);
  await page.keyboard.press("Escape");

  // Media capabilities inside WebView2
  const caps = await page.evaluate(async () => {
    const r = { getDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === "function", rtc: typeof RTCPeerConnection === "function" };
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      r.mic = s.getAudioTracks()[0]?.label || "ok";
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      r.mic = `error: ${e.name}`;
    }
    const devs = await navigator.mediaDevices.enumerateDevices();
    r.devices = devs.map((d) => d.kind).reduce((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
    r.codecs = RTCRtpSender.getCapabilities("video").codecs.map((c) => c.mimeType).filter((v, i, a) => a.indexOf(v) === i);
    return r;
  });
  check("WebRTC + getDisplayMedia available in WebView2", caps.rtc && caps.getDisplayMedia, JSON.stringify(caps.codecs));
  check("microphone permission granted by app handler (no prompt)", !String(caps.mic).startsWith("error"), `Geräte: ${JSON.stringify(caps.devices)}`);

  await page.locator(".chan", { hasText: "Allgemein" }).last().click();
  await page.waitForSelector(".voice-view .voice-controls", { timeout: 15000 });
  await sleep(1500);
  const vstate = await page.evaluate(() => document.querySelector(".voice-panel .status")?.textContent);
  check("joined voice channel in desktop app", !!vstate, vstate ?? "");
  await page.screenshot({ path: join(shots, "04-voice.png") });

  // Screen capture: the native picker must open. It cannot be clicked
  // automatically and stays open until the app closes, so this runs last.
  const picker = await page.evaluate(
    () =>
      new Promise((res) => {
        let settled = false;
        navigator.mediaDevices
          .getDisplayMedia({ video: true, audio: true })
          .then((s) => { settled = true; s.getTracks().forEach((t) => t.stop()); res("granted"); })
          .catch((e) => { settled = true; res(`rejected: ${e.name}`); });
        setTimeout(() => !settled && res("picker-open"), 2500);
      }),
  );
  check("getDisplayMedia opens a source picker (not rejected)", !String(picker).startsWith("rejected"), picker);
} catch (e) {
  check("run", false, String(e?.stack ?? e));
  await page.screenshot({ path: join(shots, "error.png") }).catch(() => {});
} finally {
  writeFileSync(join(ROOT, "tests", "e2e", "desktop-last-run.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
}

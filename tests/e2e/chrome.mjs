// Desktop check of the window chrome: themed title bar with working window
// buttons, footer (donate, copyright, language flag), and the settings close
// button staying visible while scrolling. Takes screenshots per design.
//
// Uses the isolated test build (see tests/e2e/hosting.mjs) and a seeded server:
//   node tests/e2e/seed.mjs 7979            → prints "READY <address> <token>"
//   node tests/e2e/chrome.mjs <address> <token>

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = process.env.NEXUS_EXE || join(ROOT, "target", "debug", "nexustalk.exe");
const [address, token] = process.argv.slice(2);
const CDP = 9225;
const SHOTS = process.env.SHOTS_DIR || null;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};
async function waitFor(fn, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(250);
  }
  return null;
}

const appData = mkdtempSync(join(tmpdir(), "nx-chrome-"));
const app = spawn(EXE, [], { env: { ...process.env, APPDATA: appData, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` }, stdio: "ignore" });
let browser;

async function shot(page, name) {
  if (!SHOTS) return;
  const cdp = await page.context().newCDPSession(page);
  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 88, clip: { x: 0, y: 0, width, height, scale: 1.5 } });
  writeFileSync(join(SHOTS, name), Buffer.from(r.data, "base64"));
}

try {
  browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP}`), 30000);
  const page = await waitFor(() => browser.contexts()[0]?.pages().find((p) => p.url().includes("tauri.localhost")));
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.waitForSelector(".rail");
  const servers = address ? [{ id: "s1", address, fingerprint: null, name: "Cyber Crew", username: "christian", token }] : [];
  const setCfg = (theme) =>
    page.evaluate(([servers, theme]) => window.__TAURI_INTERNALS__.invoke("config_save", { config: { servers, settings: { language: "de", theme, notifications: false }, host_autostart: false, minimize_to_tray: true } }), [servers, theme]);
  await setCfg("emerald");
  await page.reload();
  await page.waitForSelector(".titlebar");
  if (address) await page.waitForSelector(".msg", { timeout: 15000 }).catch(() => {});

  const tb = await page.evaluate(() => {
    const t = document.querySelector(".titlebar");
    return { drag: t?.hasAttribute("data-tauri-drag-region"), buttons: t?.querySelectorAll(".tb-btn").length, title: t?.querySelector(".tb-title")?.textContent, h: t?.getBoundingClientRect().height };
  });
  check("title bar is drawn by the app with three window buttons", tb.drag && tb.buttons === 3 && tb.h >= 28, JSON.stringify(tb));
  const decorated = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_decorated", { label: "main" }).catch((e) => String(e)));
  check("native Windows title bar is off", decorated === false, String(decorated));

  await page.locator(".tb-btn").nth(1).click();
  const maxed = await waitFor(() => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_maximized", { label: "main" })));
  check("maximize button works", maxed === true);
  await page.locator(".tb-btn").nth(1).click();
  const restored = await waitFor(async () => (await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_maximized", { label: "main" }))) === false);
  check("restore button works", !!restored);

  const foot = await page.evaluate(() => {
    const f = document.querySelector(".app-foot");
    const r = f?.getBoundingClientRect();
    return { text: f?.textContent, flag: !!f?.querySelector(".foot-flag svg"), bottom: Math.round(innerHeight - (r?.bottom ?? 0)), right: Math.round(innerWidth - (f?.querySelector(".foot-flag")?.getBoundingClientRect().right ?? 0)) };
  });
  check("footer shows donate link, copyright and the flag bottom right", /Spenden/.test(foot.text) && /© 2026 Christian Schiessl/.test(foot.text) && foot.flag && foot.bottom <= 1 && foot.right < 30, JSON.stringify(foot));
  check("no heart or flag left in the rail", (await page.locator(".rail .rail-btn.heart, .rail .rail-btn.flag").count()) === 0);
  await shot(page, "desk-emerald.jpg");

  for (const th of ["sunset", "aurora", "sakura"]) {
    await setCfg(th);
    await page.reload();
    await page.waitForSelector(".titlebar");
    if (address) await page.waitForSelector(".msg", { timeout: 15000 }).catch(() => {});
    await sleep(500);
    await shot(page, `desk-${th}.jpg`);
  }

  // Reachability helpers.
  const fw = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("firewall_check"));
  check("firewall status can be read without admin rights", fw.supported === true && !fw.error && typeof fw.allow === "number", JSON.stringify(fw));
  await page.locator(".rail .rail-btn.add").click();
  await page.locator(".modal input.input").fill("127.0.0.1:7998");
  await page.locator(".modal .btn.primary").click();
  const help = await waitFor(() => page.locator(".modal .notice.warn").textContent({ timeout: 500 }), 20000);
  check("connecting to a PC without server explains the cause", /läuft kein NexusTalk-Server/.test(help ?? ""), help ?? "");
  // No answer at all (what a blocking firewall looks like from outside).
  await page.locator(".modal input.input").fill("10.255.255.1:7878");
  await page.locator(".modal .btn.primary").click();
  const help2 = await waitFor(async () => {
    const tx = await page.locator(".modal .notice.warn").textContent({ timeout: 500 });
    return /antwortet nicht/.test(tx ?? "") ? tx : null;
  }, 30000);
  check("an unanswered connection points to firewall and server mode", /Firewall freigeben/.test(help2 ?? ""), help2 ?? "");
  await page.keyboard.press("Escape");

  // Settings: close button stays visible while scrolling.
  await page.locator(".user-panel .who").click();
  await page.waitForSelector(".pane-nav");
  await page.locator(".pane-nav button", { hasText: "Design & Sprache" }).click();
  await page.evaluate(() => {
    const c = document.querySelector(".pane-content");
    c.scrollTop = c.scrollHeight;
  });
  await sleep(300);
  const close = await page.evaluate(() => {
    const b = document.querySelector(".pane-close button")?.getBoundingClientRect();
    const m = document.querySelector(".modal.wide")?.getBoundingClientRect();
    const scrolled = document.querySelector(".pane-content").scrollTop;
    return { scrolled, visible: !!b && !!m && b.top >= m.top && b.top < m.top + 60 && b.right <= m.right + 1 };
  });
  check("settings close button stays visible after scrolling", close.scrolled > 100 && close.visible, JSON.stringify(close));
  await shot(page, "desk-settings-scrolled.jpg");
  await page.locator(".pane-close button").click();
  check("close button closes the settings", (await page.locator(".pane-nav").count()) === 0);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  await sleep(1200);
  try {
    app.kill();
  } catch {
    /* gone */
  }
  await sleep(500);
  rmSync(appData, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

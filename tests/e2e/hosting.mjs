// Drives the real desktop app (WebView2) through the hosting center:
// create two servers on different ports, set up the owner, check the
// invite links, then remove both again.
//
// The app is started with its own data folder (APPDATA → temp), so an
// installed NexusTalk and its data are not touched. Build a test binary with
// its own identifier first, so the single-instance lock of an installed
// NexusTalk does not interfere:
//
//   echo {"identifier":"org.nexustalk.e2etest"} > e2e.json
//   cd app && npx tauri build --debug --no-bundle --config ../e2e.json
//   node tests/e2e/hosting.mjs

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = process.env.NEXUS_EXE || join(ROOT, "target", "debug", "nexustalk.exe");
const CDP = 9224;
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

const appData = mkdtempSync(join(tmpdir(), "nx-hosting-"));
const app = spawn(EXE, [], {
  env: { ...process.env, APPDATA: appData, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` },
  stdio: "ignore",
});
let browser;
const shot = async (page, name) => SHOTS && page.screenshot({ path: join(SHOTS, name) });

try {
  browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP}`), 30000);
  if (!browser) throw new Error("could not attach to the app");
  const page = await waitFor(() => browser.contexts()[0]?.pages().find((p) => p.url().includes("tauri.localhost")));
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.waitForSelector(".rail");
  await page.evaluate(async () => {
    // Fixed language for stable selectors.
    const { invoke } = window.__TAURI_INTERNALS__;
    await invoke("config_save", { config: { servers: [], settings: { language: "de", notifications: false }, host_autostart: false, minimize_to_tray: true } });
  });
  await page.reload();
  await page.waitForSelector(".rail");

  // ------------------------------------------------------------ entry point
  const hostBtn = page.locator(".rail .rail-btn.host");
  check("hosting button sits at the bottom of the rail", (await hostBtn.count()) === 1 && (await hostBtn.boundingBox()).y > (await page.locator(".rail .rail-btn.add").boundingBox()).y + 100);
  await hostBtn.click();
  await page.waitForSelector(".host-modal");
  check("first visit shows the create form with a preset name", (await page.locator(".new-server input.input").inputValue()) === "Mein Server");
  await shot(page, "host-new.png");

  async function createServer(name) {
    if ((await page.locator(".new-server").count()) === 0) await page.locator(".host-modal .add-host").click();
    await page.locator(".new-server input.input").fill(name);
    await page.locator(".new-server .reach-opt", { hasText: "Nur dieser PC" }).click();
    await page.locator(".new-server .btn.primary").click();
    await page.waitForSelector(".owner-card", { timeout: 20000 });
    const user = await page.locator(".owner-card input").first().inputValue();
    if (!user) await page.locator(".owner-card input").first().fill("owner");
    await page.locator(".owner-card input[type=password]").fill("testpass123");
    await page.locator(".owner-card .btn.primary").click();
    const link = await waitFor(async () => {
      const t = await page.locator(".invite-link").textContent({ timeout: 500 });
      return t && t.startsWith("nexustalk://") ? t : null;
    }, 30000);
    return { user, link };
  }

  const a = await createServer("Testserver A");
  check("server A: owner created with prefilled name", !!a.user, a.user);
  check("server A: permanent invite link shown", !!a.link, a.link ?? "");
  await shot(page, "host-detail.png");

  const b = await createServer("Testserver B");
  check("server B: invite link shown", !!b.link, b.link ?? "");
  const port = (l) => Number(/:(\d+)\//.exec(l ?? "")?.[1]);
  check("both servers use different ports", port(a.link) > 0 && port(b.link) > 0 && port(a.link) !== port(b.link), `${port(a.link)} / ${port(b.link)}`);

  const list = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("host_list"));
  check("both servers run at the same time", list.length === 2 && list.every((h) => h.running), list.map((h) => `${h.name}:${h.port}:${h.running}`).join(", "));
  check("rail badge counts running servers", (await page.locator(".rail-host-badge.on").textContent()) === "2");
  check("both servers appear in the server list", (await page.locator(".rail .rail-item .rail-btn[title='Testserver A'], .rail .rail-item .rail-btn[title='Testserver B']").count()) === 2);
  const regFile = JSON.parse(readFileSync(join(appData, "NexusTalk", "hosts.json"), "utf8"));
  check("registry stores both servers", regFile.hosts.length === 2 && regFile.hosts.every((h) => h.autostart), regFile.hosts.map((h) => h.dir).join(", "));

  // Reopening shows the same invite link (permanent, not recreated).
  await page.keyboard.press("Escape");
  await hostBtn.click();
  await page.locator(".host-modal .pane-nav button", { hasText: "Testserver A" }).click();
  const again = await waitFor(async () => {
    const t = await page.locator(".invite-link").textContent({ timeout: 500 });
    return t?.startsWith("nexustalk://") ? t : null;
  });
  check("invite link stays the same when reopened", again === a.link);

  // ------------------------------------------------------------ remove
  for (const name of ["Testserver B", "Testserver A"]) {
    await page.locator(".host-modal .pane-nav button", { hasText: name }).click();
    await page.locator(".pane-content .btn.danger-text").click();
    await page.locator(".modal .btn.danger", { hasText: "Server entfernen" }).click();
    await waitFor(async () => (await page.locator(".host-modal .pane-nav button", { hasText: name }).count()) === 0);
  }
  const after = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("host_list"));
  check("servers can be removed again", after.length === 0);
  check("data folders are deleted", !regFile.hosts.some((h) => existsSync(join(appData, "NexusTalk", h.dir))));
  check("client entries are removed too", (await page.locator(".rail .rail-item .rail-btn[title^='Testserver']").count()) === 0);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("quit_app")).catch(() => {});
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  await sleep(1500);
  try {
    app.kill();
  } catch {
    /* already gone */
  }
  await sleep(500);
  rmSync(appData, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
writeFileSync(join(ROOT, "tests", "e2e", "hosting-last-run.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed ? 1 : 0);

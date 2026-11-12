// Drives the real desktop app (WebView2) for the parts that only exist there:
//   1. hosted servers start together with the app (also after an upgrade from
//      a version where the per-server switch was off), the global switch turns
//      that off, and a stopped server starts with one click
//   2. the native helpers behind 0.10: device secrets, writing large files in
//      pieces, the monitor used for remote control, the annotation overlay
//
// Nothing is injected into the real desktop here (see the Rust unit tests for
// the input mapping). The app runs with its own data folder (APPDATA → temp).
//
//   echo {"identifier":"org.nexustalk.e2etest"} > e2e.json
//   cd app && npx tauri build --debug --no-bundle --config ../e2e.json
//   node tests/e2e/native.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EXE = process.env.NEXUS_EXE || join(ROOT, "target", "debug", "Domus.exe");
const CDP = 9226;
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

const appData = mkdtempSync(join(tmpdir(), "nx-native-"));
const dataDir = join(appData, "NexusTalk");
let app = null;
let browser = null;

async function launch() {
  app = spawn(EXE, [], { env: { ...process.env, APPDATA: appData, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP}` }, stdio: "ignore" });
  browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${CDP}`), 30000);
  if (!browser) throw new Error("could not attach to the app");
  const page = await waitFor(() => browser.contexts()[0]?.pages().find((p) => p.url().includes("tauri.localhost") && !p.url().includes("ink.html")));
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.waitForSelector(".rail");
  return page;
}
async function quit() {
  await browser?.close().catch(() => {});
  app?.kill();
  await sleep(1500);
}
const invoke = (page, cmd, args) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args ?? {}]);

try {
  // ------------------------------------------------------------ run 1: create a server
  let page = await launch();
  await invoke(page, "config_save", { config: { servers: [], settings: { language: "de", notifications: false }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true } });
  const created = await invoke(page, "host_create", { name: "Autostart-Test", exposed: false });
  check("a new server is created with autostart on", created.autostart === true);
  const hostId = created.id;
  // Own ports, so a NexUs that is installed and hosting on this PC is not disturbed.
  await invoke(page, "host_stop", { id: hostId }).catch(() => {});
  const hc = await invoke(page, "host_config", { id: hostId });
  await invoke(page, "host_config_save", { id: hostId, config: { ...hc, port: 7996, media: { ...hc.media, udp_port: 3496 } } });

  // ---- native helpers
  await invoke(page, "secret_set", { name: "e2e.test.1", value: "privater-schluessel-äöü" });
  const secret = await invoke(page, "secret_get", { name: "e2e.test.1" });
  const onDisk = readFileSync(join(dataDir, "secrets.json"), "utf8");
  check("secrets: stored protected and read back", secret === "privater-schluessel-äöü" && !onDisk.includes("privater-schluessel"));
  check("secrets: invalid names are refused", (await invoke(page, "secret_get", { name: "../client" })) === null);
  await invoke(page, "secret_set", { name: "e2e.test.1", value: null });
  check("secrets: can be removed", (await invoke(page, "secret_get", { name: "e2e.test.1" })) === null);

  // Writing a file in raw pieces (what a direct transfer or a clip does).
  const target = join(appData, "empfangen.bin");
  const sent = await page.evaluate(async (path) => {
    const { invoke } = window.__TAURI_INTERNALS__;
    const id = await invoke("file_save_begin", { path });
    const hash = [];
    let total = 0;
    for (let i = 0; i < 5; i++) {
      const chunk = new Uint8Array(1024 * 1024 + i * 7);
      for (let o = 0; o < chunk.length; o += 65536) crypto.getRandomValues(chunk.subarray(o, Math.min(o + 65536, chunk.length)));
      hash.push(chunk);
      total = await invoke("file_save_chunk", chunk, { headers: { "x-id": String(id) } });
    }
    const written = await invoke("file_save_end", { id, keep: true });
    const all = new Uint8Array(hash.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of hash) {
      all.set(c, o);
      o += c.length;
    }
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", all))].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { total, written, size: all.length, digest };
  }, target);
  const file = existsSync(target) ? readFileSync(target) : Buffer.alloc(0);
  check("file sink: pieces arrive complete and in order", sent.written === sent.size && file.length === sent.size && createHash("sha256").update(file).digest("hex") === sent.digest, `${file.length} bytes`);
  const dropped = join(appData, "abgebrochen.bin");
  await page.evaluate(async (path) => {
    const { invoke } = window.__TAURI_INTERNALS__;
    const id = await invoke("file_save_begin", { path });
    await invoke("file_save_chunk", new Uint8Array([1, 2, 3]), { headers: { "x-id": String(id) } });
    await invoke("file_save_end", { id, keep: false });
  }, dropped);
  check("file sink: a cancelled transfer leaves no partial file", !existsSync(dropped));

  // Remote-control target monitor and the annotation overlay.
  const primary = await invoke(page, "remote_set_target", { label: null });
  const byLabel = await invoke(page, "remote_set_target", { label: "screen:0:0" });
  const unknown = await invoke(page, "remote_set_target", { label: "screen:-3:0" });
  check("remote: target monitor resolved (label, fallback to primary)", Array.isArray(primary) && primary[2] > 0 && Array.isArray(byLabel) && byLabel[2] > 0 && JSON.stringify(unknown) === JSON.stringify(primary), `primary ${JSON.stringify(primary)}, screen:0 ${JSON.stringify(byLabel)}`);
  await invoke(page, "remote_inject", { cmds: [{ t: "m", x: 0.5, y: 0.5 }] });
  check("remote: input is ignored while no session is allowed", true);
  const shown = await invoke(page, "ink_overlay", { show: true });
  const overlay = await waitFor(() => browser.contexts()[0].pages().find((p) => p.url().includes("ink.html")), 10000);
  const canvas = overlay ? await overlay.evaluate(() => ({ w: document.getElementById("ink")?.width ?? 0, bg: getComputedStyle(document.body).backgroundColor })) : null;
  check("ink: transparent overlay window opens with its canvas", shown === true && !!canvas && canvas.w > 0 && canvas.bg === "rgba(0, 0, 0, 0)", JSON.stringify(canvas));
  // A stroke sent to the overlay is painted there.
  await page.evaluate(async () => {
    const { invoke, transformCallback } = window.__TAURI_INTERNALS__;
    void transformCallback;
    await invoke("plugin:event|emit_to", { target: { kind: "AnyLabel", label: "ink" }, event: "ink", payload: { k: "stroke", key: "1:1", color: "#ff3b5c", width: 0.01, pts: [0.1, 0.1, 0.5, 0.5, 0.9, 0.2], end: false } });
  });
  const painted = overlay
    ? await waitFor(() => overlay.evaluate(() => {
        const c = document.getElementById("ink");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n > 500 ? n : null;
      }), 6000)
    : null;
  check("ink: a forwarded stroke is drawn on the overlay", !!painted, JSON.stringify(painted));
  await invoke(page, "ink_overlay", { show: false });
  check("ink: overlay closes again", !!(await waitFor(() => !browser.contexts()[0].pages().some((p) => p.url().includes("ink.html")), 8000)));
  await quit();

  // ------------------------------------------------------------ run 2: upgrade from an older version
  // An older version wrote no "rev" and had the per-server switch off.
  const hostsPath = join(dataDir, "hosts.json");
  const reg = JSON.parse(readFileSync(hostsPath, "utf8"));
  reg.hosts.forEach((h) => (h.autostart = false));
  delete reg.rev;
  writeFileSync(hostsPath, JSON.stringify(reg));
  page = await launch();
  const auto = await waitFor(async () => (await invoke(page, "host_list")).find((h) => h.id === hostId && h.running), 30000);
  check("autostart: the server starts by itself after the upgrade", !!auto, auto ? auto.address : "");
  check("autostart: per-server switch was turned on once", JSON.parse(readFileSync(hostsPath, "utf8")).rev === 1 && auto?.autostart === true);
  // Global switch off, with a client entry for the hosted server.
  const cfg = (await invoke(page, "config_load")).config;
  await invoke(page, "config_save", {
    config: { ...cfg, hosts_autostart: false, servers: [{ id: "c1", address: `https://127.0.0.1:${auto.port}`, fingerprint: auto.fingerprint, name: "Autostart-Test", username: "owner", token: "ungueltig", hosted: true, host_id: hostId }] },
  });
  await quit();

  // ------------------------------------------------------------ run 3: switched off, one click starts it
  page = await launch();
  await sleep(6000);
  const off = (await invoke(page, "host_list")).find((h) => h.id === hostId);
  check("autostart: the global switch keeps servers stopped", off && off.running === false);
  await page.locator(".rail-item .rail-btn:not(.home):not(.add):not(.host)").first().click();
  const banner = await waitFor(() => page.locator(".conn-banner.stopped").count());
  check("stopped server: banner with a start button instead of 'connecting'", !!banner && (await page.locator(".conn-banner.stopped").innerText()).includes("läuft gerade nicht"));
  await page.locator(".conn-banner.stopped .btn").click();
  const started = await waitFor(async () => (await invoke(page, "host_list")).find((h) => h.id === hostId && h.running), 30000);
  check("stopped server: one click starts it", !!started);
  check("the settings offer the global switch", await page.evaluate(async () => {
    document.querySelector(".user-panel .who")?.click();
    await new Promise((r) => setTimeout(r, 500));
    [...document.querySelectorAll(".pane-nav button")].find((b) => b.textContent.includes("App"))?.click();
    await new Promise((r) => setTimeout(r, 500));
    return document.body.innerText.includes("Eigene Server beim Programmstart starten");
  }));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await quit();
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(ROOT, "tests", "e2e", "native-last-run.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

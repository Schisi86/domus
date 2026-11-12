// End-to-end test of Domus 1.0.1 in the real web UI on a phone-sized screen
// (Android user agent, touch): moving the profile with a QR code that a fake
// camera films, the one-column phone layout with the back key, member sheet,
// menus as bottom sheets, swipe to reply, drafts, "Enter adds a line", the
// device list with signing out another device, and pausing notifications.
//
// The Android app itself runs the same UI in the Android web view; this test
// covers the UI logic, not the Android shell (see docs/TESTING.md).
//
// Usage: node tests/e2e/mobile.mjs   (requires `cargo build -p nexus-server`
// and the UI dev server: npm --prefix app run dev)

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(ROOT, "app", "package.json"));
const jsQR = require("jsqr");
const PORT = 7996;
const ADDR = `http://127.0.0.1:${PORT}`;
const UI = "http://localhost:5173";
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};
async function waitFor(fn, timeout = 15000, step = 200) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(step);
  }
  return null;
}

const dataDir = mkdtempSync(join(tmpdir(), "nx-mobile-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = false\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "domus-server.exe" : "domus-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });

async function api(path, body, token) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
function wsCall(token, op, d) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.re === 1 && !f.ok) return ws.close(), rej(f.err);
      if (f.re === 1) ws.send(JSON.stringify({ id: 2, op, d }));
      if (f.re === 2) {
        ws.close();
        f.ok ? res(f.d) : rej(f.err);
      }
    };
    ws.onerror = rej;
    ws.onclose = () => rej({ code: "CLOSED" });
  });
}

/** Puts a screenshot (PNG) of a QR code on a white 640×480 frame: an MJPEG
 *  file for Chromium's fake camera, plus the decoded text (jsQR, as in the app). */
async function qrVideo(helper, png, file) {
  const p = await helper.newPage();
  const { jpeg, rgba } = await p.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = 640;
    cv.height = 480;
    const g = cv.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 640, 480);
    g.imageSmoothingEnabled = false;
    const k = Math.min(440 / img.width, 440 / img.height);
    g.drawImage(img, (640 - img.width * k) / 2, (480 - img.height * k) / 2, img.width * k, img.height * k);
    const d = g.getImageData(0, 0, 640, 480);
    return { jpeg: cv.toDataURL("image/jpeg", 0.95).split(",")[1], rgba: Array.from(d.data) };
  }, `data:image/png;base64,${png.toString("base64")}`);
  await p.close();
  const frame = Buffer.from(jpeg, "base64");
  writeFileSync(file, Buffer.concat(Array(30).fill(frame)));
  const hit = jsQR(Uint8ClampedArray.from(rgba), 640, 480);
  return hit?.data ?? null;
}
const decode = (text) => JSON.parse(Buffer.from(text.slice("domus-link:".length), "base64url").toString("utf8"));

/** Opens a profile; `cfg` is written before the page loads (null = empty). */
async function openProfile(browser, profile, cfg, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.grantPermissions(["camera", "microphone"], { origin: UI });
  await ctx.addInitScript(([key, value]) => {
    if (location.origin !== "http://localhost:5173") return;
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      if (value) localStorage.setItem(key, value);
      else localStorage.removeItem(key);
      localStorage.removeItem("domus.drafts");
    }
  }, [`nexustalk.config.${profile}`, cfg ? JSON.stringify(cfg) : null]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${profile}] pageerror`, e.message));
  await page.goto(`${UI}/?profile=${profile}`);
  return page;
}

/** Opens "Move profile › Send" (right-click on the own name) and returns a screenshot of the QR code. */
async function showQr(page) {
  await page.locator(".user-panel .who").click({ button: "right" });
  await page.locator(".menu button", { hasText: "Profil übertragen" }).click();
  await page.getByRole("button", { name: "Von diesem Gerät senden" }).click();
  const qr = page.locator(".transfer-qr .qr-wrap");
  await qr.waitFor({ timeout: 15000 });
  return qr.screenshot();
}

const PHONE = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
};

const browsers = [];
const launch = async (camera) => {
  const b = await chromium.launch({
    headless: true,
    // "domus.local" stands in for a LAN address: loopback addresses are never put into a QR code.
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--host-resolver-rules=MAP domus.local 127.0.0.1", ...(camera ? [`--use-file-for-fake-video-capture=${camera}`] : [])],
  });
  browsers.push(b);
  return b;
};
const LAN = `http://domus.local:${PORT}`;
try {
  if (!(await waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok))) throw new Error("server did not start");
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const a = await api("/api/v1/auth/register", { username: "alice", password: "testpass123", invite: setup, device: "Domus Desktop (Windows)" });
  const aliceToken = a.body.token;
  const ready = await wsCall(aliceToken, "message.send", { channel_id: 1, content: "Hallo vom PC 👋" }).catch(() => null);
  await wsCall(aliceToken, "message.send", { channel_id: 1, content: "Zweite Nachricht zum Antworten" }).catch(() => null);
  check("messages for the phone test", !!ready);
  if (!(await waitFor(async () => (await fetch(UI)).ok, 3000))) throw new Error(`UI dev server not reachable at ${UI}`);

  // --- PC → phone: the PC shows its QR code, the phone's camera reads it
  const helper = await launch(null);
  const pcCfg = { servers: [{ id: "srv", address: LAN, fingerprint: null, name: "E2E-Server", username: "alice", token: aliceToken }], settings: { theme: "fjord", msgScale: 1.15, uiSounds: false }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
  const pc = await openProfile(helper, "pc", pcCfg, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });
  await pc.waitForSelector(".chan .name", { timeout: 15000 });
  const text1 = await qrVideo(helper, await showQr(pc), join(dataDir, "pc.mjpeg"));
  const p1 = text1 && decode(text1);
  check("PC shows a QR code with a one-time code for its server", p1?.s?.length === 1 && p1.s[0].c.length === 20 && p1.s[0].a[0] === LAN, text1?.slice(0, 40));
  check("QR code carries the design settings", p1?.p?.theme === "fjord" && p1.p.msgScale === 1.15);

  const phoneBrowser = await launch(join(dataDir, "pc.mjpeg"));
  const page = await openProfile(phoneBrowser, "phone", null, PHONE);
  await page.getByRole("button", { name: "Von anderem Gerät übertragen" }).click();
  const scanned = await waitFor(() => page.locator("text=Von „Browser (Web)“").count(), 45000);
  check("phone camera reads the PC's QR code", !!scanned);
  if (!scanned && process.env.DEBUG_DIR) {
    await page.screenshot({ path: join(process.env.DEBUG_DIR, "phone-scan.png") });
    writeFileSync(join(process.env.DEBUG_DIR, "pc-frame.jpg"), readFileSync(join(dataDir, "pc.mjpeg")).subarray(0, readFileSync(join(dataDir, "pc.mjpeg")).length / 30));
  }
  await page.getByRole("button", { name: "1 Server übernehmen" }).click();
  check("phone signs in with the code (own session)", !!(await waitFor(() => page.locator(".transfer >> text=angemeldet").count())));
  check("PC is told about the new device", !!(await waitFor(() => pc.locator(".toast", { hasText: "Neues Gerät angemeldet" }).count())));
  check("PC dialog confirms the transfer", !!(await waitFor(() => pc.locator(".notice.ok", { hasText: "ist jetzt angemeldet" }).count())));
  // The app saves its configuration 0.4 s after a change.
  const cfg = (await waitFor(async () => {
    const c = JSON.parse((await page.evaluate(() => localStorage.getItem("nexustalk.config.phone"))) ?? "{}");
    return c.servers?.length && c.settings?.theme === "fjord" ? c : null;
  }, 5000)) ?? JSON.parse((await page.evaluate(() => localStorage.getItem("nexustalk.config.phone"))) ?? "{}");
  const srv = cfg.servers?.[0];
  check("server saved with a new token, not the PC's", srv?.username === "alice" && srv.token && srv.token !== aliceToken && srv.address === LAN);
  check("design and text size came along", cfg.settings?.theme === "fjord" && cfg.settings?.msgScale === 1.15, `${cfg.settings?.theme} ${cfg.settings?.msgScale}`);
  const reuse = await api("/api/v1/auth/link", { code: p1?.s?.[0]?.c ?? "x" });
  check("a used code is refused", reuse.status === 401);
  const devs = await wsCall(aliceToken, "device.list", {});
  check("both devices are listed on the server", devs.devices?.length === 2 && devs.devices.some((d) => /Android|Browser/.test(d.device)), devs.devices?.map((d) => d.device).join(", "));
  await page.getByRole("button", { name: "Fertig" }).click();

  // --- and back: phone → a second PC (empty profile)
  await waitFor(() => page.locator(".chan .name").count());
  const text2 = await qrVideo(helper, await showQr(page), join(dataDir, "phone.mjpeg"));
  const p2 = text2 && decode(text2);
  check("phone shows a QR code too", p2?.s?.length === 1 && p2.s[0].u === "alice", text2?.slice(0, 40));
  await page.getByRole("button", { name: "Schließen" }).last().click();
  const pc2Browser = await launch(join(dataDir, "phone.mjpeg"));
  const pc2 = await openProfile(pc2Browser, "pc2", null, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3 });
  await pc2.getByRole("button", { name: "Von anderem Gerät übertragen" }).click();
  check("second PC reads the phone's QR code", !!(await waitFor(() => pc2.locator("text=1 Server übernehmen").count(), 45000)));
  await pc2.getByRole("button", { name: "1 Server übernehmen" }).click();
  check("second PC signs in", !!(await waitFor(() => pc2.locator(".transfer >> text=angemeldet").count())));
  await pc2.getByRole("button", { name: "Fertig" }).click();
  check("second PC shows the server's channels", !!(await waitFor(() => pc2.locator(".chan", { hasText: "allgemein" }).count())));
  check("three devices signed in", (await wsCall(aliceToken, "device.list", {})).devices?.length === 3);

  // --- phone layout: channel list ↔ chat, back key
  const nav = await waitFor(() => page.evaluate(() => document.querySelector(".app")?.classList.contains("nav-open") && document.querySelector(".chan .name") !== null));
  check("phone starts on the channel list", !!nav);
  if (!nav && process.env.DEBUG_DIR) {
    await page.screenshot({ path: join(process.env.DEBUG_DIR, "phone-nav.png") });
    console.log(await page.evaluate(() => document.querySelector(".app")?.className + " | modal:" + !!document.querySelector(".overlay")));
  }
  await page.locator(".chan", { hasText: "allgemein" }).first().click();
  const content = await waitFor(() => page.evaluate(() => !document.querySelector(".app").classList.contains("nav-open") && getComputedStyle(document.querySelector(".main")).display !== "none" && getComputedStyle(document.querySelector(".sidebar")).display === "none"));
  check("picking a channel shows only the chat", !!content);
  check("message text uses the chosen size", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--msg-scale").trim())) === "1.15");
  await page.goBack();
  check("back key returns to the channel list", !!(await waitFor(() => page.evaluate(() => document.querySelector(".app").classList.contains("nav-open")))));
  await page.locator(".chan", { hasText: "allgemein" }).first().click();
  await page.locator(".nav-back").click();
  check("back arrow in the header returns as well", !!(await waitFor(() => page.evaluate(() => document.querySelector(".app").classList.contains("nav-open")))));
  await page.locator(".chan", { hasText: "allgemein" }).first().click();

  // --- member list as a sheet
  await page.getByRole("button", { name: "Mitgliederliste anzeigen" }).first().click();
  check("member list opens as a sheet", !!(await waitFor(() => page.locator(".sheet .members").count())));
  await page.goBack();
  check("back key closes the sheet first", !!(await waitFor(() => page.evaluate(() => !document.querySelector(".sheet") && !document.querySelector(".app").classList.contains("nav-open")))));

  // --- long press menu as bottom sheet
  await waitFor(() => page.locator(".msg").count());
  const menu = await page.evaluate(async () => {
    const m = document.querySelector(".msg");
    const r = m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.x + 50, clientY: r.y + 10 }));
    await new Promise((res) => setTimeout(res, 300));
    const box = document.querySelector(".menu")?.getBoundingClientRect();
    return box && { bottom: innerHeight - box.bottom, width: box.width };
  });
  check("message menu is a bottom sheet", menu && menu.bottom < 20 && menu.width > 340, JSON.stringify(menu));
  await page.mouse.click(200, 100);

  // --- swipe to reply
  const reply = await page.evaluate(async () => {
    const m = [...document.querySelectorAll(".msg")].pop();
    const r = m.getBoundingClientRect();
    const t = (x) => new Touch({ identifier: 1, target: m, clientX: x, clientY: r.y + 15 });
    m.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [t(330)], changedTouches: [t(330)] }));
    for (const x of [320, 300, 270, 240, 230]) m.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [t(x)], changedTouches: [t(x)] }));
    m.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [t(230)] }));
    await new Promise((res) => setTimeout(res, 300));
    return document.querySelector(".composer-wrap")?.innerText ?? "";
  });
  check("swiping a message left replies to it", reply.includes("Zweite Nachricht"), reply.slice(0, 60));

  // --- Enter adds a line on phones; drafts survive switching
  const ta = page.locator(".composer textarea");
  await ta.click();
  await ta.type("Erste Zeile");
  await ta.press("Enter");
  await ta.type("zweite Zeile");
  check("Enter adds a line on phones (send button sends)", (await ta.inputValue()) === "Erste Zeile\nzweite Zeile");
  await page.goBack();
  check("draft mark in the channel list", !!(await waitFor(() => page.locator(".chan svg title", { hasText: "Entwurf" }).count())));
  await page.locator(".chan", { hasText: "allgemein" }).first().click();
  check("draft is still there after switching", (await page.locator(".composer textarea").inputValue()) === "Erste Zeile\nzweite Zeile");
  await page.locator(".composer-row button[title^='Senden']").click();
  check("send button sends the draft", !!(await waitFor(() => page.locator(".msg-text", { hasText: "zweite Zeile" }).count())));
  check("draft cleared after sending", !!(await waitFor(() => page.evaluate(() => localStorage.getItem("domus.drafts") === "{}"), 3000)));

  // --- settings: devices, sign the PC out
  await page.goBack();
  await page.locator(".user-panel button[title='Einstellungen']").click();
  await page.getByRole("button", { name: "Geräte" }).click();
  check("device list shows all three devices", !!(await waitFor(() => page.locator(".device-row").count().then((n) => n === 3))));
  check("own device is marked", (await page.locator(".device-row .badge", { hasText: "Dieses Gerät" }).count()) === 1);
  await page.locator(".device-row", { hasText: "Domus Desktop (Windows)" }).locator("button", { hasText: "Abmelden" }).click();
  await page.locator(".modal button.danger", { hasText: "Abmelden" }).click();
  check("signing out the PC leaves two devices", !!(await waitFor(() => page.locator(".device-row").count().then((n) => n === 2))));
  const pcGone = await wsCall(aliceToken, "device.list", {}).then(() => false, (e) => e?.code === "UNAUTHORIZED" || e?.code === "CLOSED");
  check("the PC's session no longer works", pcGone);

  // --- pause notifications
  await page.getByRole("button", { name: "Benachrichtigungen" }).click();
  await page.getByRole("button", { name: "1 Stunde" }).click();
  const until = await page.evaluate(() => JSON.parse(localStorage.getItem("nexustalk.config.phone") || "{}").settings?.notifyPauseUntil ?? 0);
  await sleep(600);
  const until2 = await page.evaluate(() => JSON.parse(localStorage.getItem("nexustalk.config.phone") || "{}").settings?.notifyPauseUntil ?? 0);
  check("notifications paused for about an hour", Math.abs(Math.max(until, until2) - Date.now() - 3_600_000) < 60_000);
  await page.goBack();
  check("pause mark next to the own name", !!(await waitFor(() => page.locator(".user-panel .pause-mark").count())));
  await page.locator(".user-panel .pause-mark").click();
  check("one tap resumes notifications", !!(await waitFor(() => page.locator(".user-panel .pause-mark").count().then((n) => n === 0))));
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  server.kill();
  await sleep(400);
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "mobile-last-run.json"), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed, failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

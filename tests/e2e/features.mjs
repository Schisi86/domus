// End-to-end test of the screen share options menu and the image cropper.
//
// Starts a fresh headless server, drives the real web UI in Chromium with a
// fake screen source and verifies:
//   1. the share button opens the options menu (presets, resolution, fps, ...)
//   2. the chosen resolution/frame rate are applied to the captured track
//   3. quality can be changed while sharing (header chip → apply)
//   4. a non-square server icon is cropped in a dialog on top of the server
//      settings and stored as a 512×512 square
//
// Usage: node tests/e2e/features.mjs   (requires `cargo build -p nexus-server`
// and the UI dev server: npm --prefix app run dev)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7991;
const ADDR = `http://127.0.0.1:${PORT}`;
const UI = "http://localhost:5173";
const SHOTS = process.env.SHOTS_DIR || null;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};
async function waitFor(fn, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(200);
  }
  return null;
}

const dataDir = mkdtempSync(join(tmpdir(), "nx-feat-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = false\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "nexustalk-server.exe" : "nexustalk-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });
let browser;

try {
  if (!(await waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok))) throw new Error("server did not start");
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const reg = await (await fetch(`${ADDR}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "alice", password: "testpass123", invite: setup }) })).json();
  const token = reg.token;

  browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: SHOTS ? 1.5 : 1 });
  await ctx.grantPermissions(["microphone", "camera"], { origin: UI });
  const cfg = { servers: [{ id: "srv", address: ADDR, fingerprint: null, name: "E2E", username: "alice", token }], settings: { notifications: false, language: "de" } };
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ["nexustalk.config.feat", JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${UI}/?profile=feat`);
  await page.waitForSelector(".chan .name");

  // ---------------------------------------------------------- screen menu
  await page.locator(".chan", { hasText: "Allgemein" }).filter({ has: page.locator("svg") }).last().click();
  await page.locator(".voice-view .btn.primary").click().catch(() => {});
  await page.waitForSelector(".voice-controls");
  await page.locator(".voice-controls .share-group .round-btn").click();
  const menu = await page.waitForSelector(".screen-menu", { timeout: 5000 }).catch(() => null);
  check("share button opens the options menu", !!menu);
  const counts = await page.evaluate(() => ({
    presets: document.querySelectorAll(".screen-menu .preset").length,
    chips: [...document.querySelectorAll(".screen-menu .chips")].map((c) => c.children.length),
  }));
  check("menu offers presets, resolutions, frame rates and content types", counts.presets === 6 && counts.chips.join() === "5,4,3", JSON.stringify(counts));
  const share = () => window.__nexus.voice.value?.sharingScreen.value;
  check("nothing is shared before confirming", !(await page.evaluate(share)));
  await page.locator(".screen-menu .chip", { hasText: /^720p$/ }).click();
  await page.locator(".screen-menu .chip", { hasText: /^15 FPS$/ }).click();
  const est = await page.locator(".screen-est b").textContent();
  const marked = await page.evaluate(() => [...document.querySelectorAll(".screen-menu .chip.on")].map((c) => c.textContent));
  check("menu highlights the chosen options", marked.join("|") === "720p|15 FPS|Automatisch", marked.join("|"));
  if (SHOTS) {
    await sleep(400); // let the chip transitions finish
    await page.screenshot({ path: join(SHOTS, "screen-menu.png") });
  }
  await page.locator(".screen-menu .btn.primary").click();
  check("sharing starts from the menu", !!(await waitFor(() => page.evaluate(share))));
  const track = () =>
    page.evaluate(() => {
      const v = window.__nexus.voice.value;
      const s = v.screens.value.get(v.selfId);
      const t = s?.getVideoTracks()[0];
      return t ? { c: t.getConstraints(), s: t.getSettings(), hint: t.contentHint } : null;
    });
  let tr = await waitFor(track);
  check("chosen limits applied to the capture (720p, 15 FPS, detail)", tr?.c.width?.max === 1280 && tr?.c.height?.max === 720 && tr?.c.frameRate?.max === 15 && tr?.hint === "detail" && (tr?.s.width ?? 0) <= 1280, `${JSON.stringify(tr?.c)} → ${tr?.s.width}×${tr?.s.height}@${tr?.s.frameRate} (${est})`);

  await page.locator(".main-head .btn.sm", { hasText: "720p" }).click();
  await page.waitForSelector(".screen-menu");
  await page.locator(".screen-menu .preset", { hasText: "Flüssig" }).click();
  await page.locator(".screen-menu .btn.primary").click();
  tr = await waitFor(async () => {
    const x = await track();
    return x?.c.frameRate?.max === 60 ? x : null;
  });
  check("quality can be changed while sharing (1080p60, motion)", tr?.c.width?.max === 1920 && tr?.c.frameRate?.max === 60 && tr?.hint === "motion", JSON.stringify(tr?.c));
  check("header shows the current quality", (await page.locator(".main-head .btn.sm").textContent())?.includes("1080p · 60 FPS") ?? false);
  await page.locator(".voice-controls .share-group .round-btn").click();
  check("share button stops the share", !!(await waitFor(async () => !(await page.evaluate(share)))));

  // ---------------------------------------------------------- icon crop
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 400;
    const g = c.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 900, 0);
    grad.addColorStop(0, "#16c47f");
    grad.addColorStop(1, "#1683e0");
    g.fillStyle = grad;
    g.fillRect(0, 0, 900, 400);
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(450, 200, 150, 0, Math.PI * 2);
    g.fill();
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.locator(".rail-item .rail-btn[title='E2E'], .rail-item .rail-btn").nth(1).click({ button: "right" });
  await page.locator(".menu button", { hasText: "Servereinstellungen" }).click();
  await page.waitForSelector(".modal.wide");
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".modal.wide button", { hasText: "Hochladen" }).click();
  await (await chooser).setFiles({ name: "wide.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  const crop = await page.waitForSelector(".crop-modal", { timeout: 5000 }).catch(() => null);
  check("a cropper opens for the picked image", !!crop);
  check("server settings stay open underneath", (await page.locator(".modal.wide").count()) === 1);
  const stage = await page.locator(".crop-stage").boundingBox();
  await page.mouse.move(stage.x + 150, stage.y + 150);
  await page.mouse.wheel(0, -300);
  await page.mouse.down();
  await page.mouse.move(stage.x + 120, stage.y + 160, { steps: 5 });
  await page.mouse.up();
  if (SHOTS) await page.screenshot({ path: join(SHOTS, "crop.png") });
  await page.locator(".crop-modal .btn.primary").click();
  await page.waitForSelector(".crop-modal", { state: "detached" });
  const dims = await waitFor(async () => {
    const r = await fetch(`${ADDR}/api/v1/icon`, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const type = r.headers.get("content-type");
    const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
    return page.evaluate(async ([b, t]) => {
      const bmp = await createImageBitmap(await (await fetch(`data:${t};base64,${b}`)).blob());
      return { w: bmp.width, h: bmp.height, t };
    }, [b64, type]);
  });
  check("icon is stored as a 512×512 square", dims?.w === 512 && dims?.h === 512, JSON.stringify(dims));
  check("settings dialog still open after cropping", (await page.locator(".modal.wide").count()) === 1);
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
writeFileSync(join(ROOT, "tests", "e2e", "features-last-run.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
process.exit(failed ? 1 : 0);

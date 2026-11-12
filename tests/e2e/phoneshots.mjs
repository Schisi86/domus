// Phone screenshots of the real UI for the websites (Android layout).
//
//   node tests/e2e/seed.mjs 7979          (prints TOKENS …)
//   node tests/e2e/phoneshots.mjs <owner token> <out dir> [theme]
//
// "domus.local" is mapped to 127.0.0.1 so the profile-transfer QR code shows
// a non-loopback address, as on a real network.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [token, out, theme = "cyber"] = process.argv.slice(2);
if (!token || !out) throw new Error("usage: phoneshots.mjs <token> <out dir> [theme]");
mkdirSync(out, { recursive: true });
const UI = "http://localhost:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP domus.local 127.0.0.1", "--use-fake-ui-for-media-stream"] });
const ctx = await browser.newContext({
  viewport: { width: 400, height: 860 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
});
const cfg = { servers: [{ id: "s1", address: "http://domus.local:7979", fingerprint: null, name: "Cyber Crew", username: "christian", token }], settings: { theme, uiSounds: false, notifications: false }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
await ctx.addInitScript(([k, v]) => {
  localStorage.setItem(k, v);
  localStorage.removeItem("domus.drafts");
}, ["nexustalk.config.shot", JSON.stringify(cfg)]);
const page = await ctx.newPage();
await page.goto(`${UI}/?profile=shot`);
await page.waitForSelector(".chan .name", { timeout: 15000 });
await sleep(800);
const shot = (name) => page.screenshot({ path: join(out, name), type: "jpeg", quality: 88 });

await shot("phone-nav.jpg");
await page.locator(".chan", { hasText: "allgemein" }).first().click();
await sleep(1200);
await shot("phone-chat.jpg");
await page.getByRole("button", { name: "Mitgliederliste anzeigen" }).first().click();
await sleep(600);
await shot("phone-members.jpg");
await page.goBack();
await page.goBack();
await sleep(400);
await page.locator(".user-panel .who").click({ button: "right" });
await page.locator(".menu button", { hasText: "Profil übertragen" }).click();
await page.getByRole("button", { name: "Von diesem Gerät senden" }).click();
await page.locator(".transfer-qr .qr-wrap").waitFor();
await sleep(500);
await shot("phone-qr.jpg");
await browser.close();
console.log("phone shots written to", out);

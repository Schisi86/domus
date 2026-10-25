// Renders the web UI against a running test server and saves screenshots
// for several themes / languages (used for design review and the website).
//
//   node tests/e2e/shots.mjs <serverAddress> <token> <outDir> [theme:lang ...]

import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [address, token, out, ...combos] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const list = combos.length ? combos : ["emerald:de"];
const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
for (const combo of list) {
  const [theme, lang, view = "chat"] = combo.split(":");
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1.5 });
  const cfg = { servers: [{ id: "s1", address, name: "NexUs", username: "christian", token }], settings: { theme, language: lang, notifications: false } };
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ["nexustalk.config.shot", JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  await page.goto("http://localhost:5173/?profile=shot");
  await page.waitForSelector(".msg, .empty", { timeout: 15000 });
  await page.waitForTimeout(800);
  if (view === "settings") {
    await page.click(".user-panel .who");
    await page.waitForSelector(".pane-nav");
    await page.locator(".pane-nav button").nth(4).click();
    await page.waitForTimeout(400);
  } else if (view === "voice") {
    await page.locator(".chan").filter({ has: page.locator("svg") }).last().click();
    await page.waitForSelector(".voice-controls", { timeout: 15000 });
    await page.waitForTimeout(1500);
  } else if (view === "about") {
    await page.click(".user-panel .who");
    await page.waitForSelector(".pane-nav");
    await page.locator(".pane-nav button").last().click();
    await page.waitForTimeout(400);
  } else if (view === "lang") {
    await page.click(".foot-flag");
    await page.waitForTimeout(400);
  }
  // SHOT_FORMAT=jpeg produces smaller files for the website.
  const jpeg = process.env.SHOT_FORMAT === "jpeg";
  await page.screenshot({
    path: join(out, `${theme}-${lang}-${view}.${jpeg ? "jpg" : "png"}`),
    ...(jpeg ? { type: "jpeg", quality: 86 } : {}),
  });
  await ctx.close();
  console.log("saved", combo);
}
await browser.close();

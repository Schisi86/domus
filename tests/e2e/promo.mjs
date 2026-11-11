// Screenshots of the collaboration features for the websites: remote control,
// drawing on a stream, watching together, instant clip, direct transfer and
// encrypted direct messages – taken from the real web UI with two users.
//
// The "shared screen" is a drawn demo desktop (a headless browser has no real
// screen to capture); everything around it is the unmodified app.
//
//   node tests/e2e/seed.mjs            (prints READY … and TOKENS …)
//   node tests/e2e/promo.mjs <address> '<tokens json>' <outDir> [theme]
//
// Requires the UI dev server (npm --prefix app run dev).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";

const [address, tokensJson, out, theme = "cyber"] = process.argv.slice(2);
const tokens = JSON.parse(tokensJson);
const UI = "http://localhost:5173";
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 20000) {
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
  throw new Error("timeout: " + fn.toString().slice(0, 120));
}

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
});

async function open(user) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, deviceScaleFactor: 1.5 });
  await ctx.grantPermissions(["microphone", "camera"], { origin: UI });
  const cfg = { servers: [{ id: "s1", address, name: "Cyber Crew", username: user, token: tokens[user] }], settings: { theme, language: "de", notifications: false, uiSounds: false, clipSeconds: 15 }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
  await ctx.addInitScript(([k, v]) => {
    localStorage.setItem(k, v);
    delete window.showSaveFilePicker;
  }, [`nexustalk.config.promo-${user}`, JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${user}] pageerror`, e.message));
  await page.goto(`${UI}/?profile=promo-${user}`);
  await page.waitForSelector(".msg, .empty", { timeout: 20000 });
  return page;
}
const V = "window.__nexus.voice.value";
const ev = (page, expr, arg) => page.evaluate(new Function("arg", `return (${expr});`), arg);
const shot = async (page, name) => {
  await page.evaluate(() => document.querySelector(".toasts")?.setAttribute("style", "display:none"));
  await page.screenshot({ path: join(out, `${name}.jpg`), type: "jpeg", quality: 88 });
  await page.evaluate(() => document.querySelector(".toasts")?.removeAttribute("style"));
  console.log("saved", name);
};

const me = await open("christian");
const lena = await open("Lena");
const joinVoice = (page) => page.locator(".chan").filter({ has: page.locator("svg") }).last().click();
await joinVoice(lena);
await waitFor(() => ev(lena, `${V}?.state.value === "connected"`));
await joinVoice(me);
const lenaId = await waitFor(() => ev(lena, `${V}?.selfId`));
const myId = await waitFor(() => ev(me, `${V}?.selfId`));
await waitFor(async () => (await ev(me, `[...${V}.peers.values()].every((p) => p.ctrl?.readyState === "open") && ${V}.peers.size === 1`)));

// ---- Lena shares a (drawn) desktop as her whole screen
await ev(lena, `(async () => {
  const c = document.createElement("canvas"); c.width = 1920; c.height = 1080;
  const g = c.getContext("2d");
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  let t = 0;
  const draw = () => {
    t++;
    const bg = g.createLinearGradient(0, 0, 1920, 1080);
    bg.addColorStop(0, "#1b1140"); bg.addColorStop(0.5, "#0f2a52"); bg.addColorStop(1, "#0b3b44");
    g.fillStyle = bg; g.fillRect(0, 0, 1920, 1080);
    for (const [x, y, r, col] of [[300, 220, 420, "rgba(255,42,109,0.28)"], [1500, 800, 520, "rgba(5,217,232,0.22)"], [1100, 200, 300, "rgba(252,238,10,0.10)"]]) {
      const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, col); rg.addColorStop(1, "transparent");
      g.fillStyle = rg; g.fillRect(0, 0, 1920, 1080);
    }
    // editor window
    g.shadowColor = "rgba(0,0,0,0.5)"; g.shadowBlur = 40; g.shadowOffsetY = 14;
    g.fillStyle = "#14161f"; rr(110, 90, 1060, 800, 14); g.fill();
    g.shadowColor = "transparent";
    g.fillStyle = "#1c1f2b"; rr(110, 90, 1060, 44, [14, 14, 0, 0]); g.fill();
    for (const [i, col] of [[0, "#ff5f57"], [1, "#febc2e"], [2, "#28c840"]]) { g.fillStyle = col; g.beginPath(); g.arc(138 + i * 24, 112, 7, 0, 7); g.fill(); }
    g.fillStyle = "#8b90a8"; g.font = "600 17px Segoe UI, sans-serif"; g.fillText("turnier-planung.md  —  Editor", 220, 118);
    g.fillStyle = "#191b26"; g.fillRect(110, 134, 220, 756);
    g.font = "15px Segoe UI, sans-serif";
    ["📁 crew", "   📄 regeln.md", "   📄 turnier-planung.md", "   📄 teams.json", "📁 clips", "   🎬 finale.mp4", "   🎬 highlight-01.mp4"].forEach((s, i) => { g.fillStyle = i === 2 ? "#fcee0a" : "#8b90a8"; g.fillText(s, 128, 170 + i * 30); });
    const lines = [[0, 420, "#ff2a6d"], [1, 300, "#c8cbe0"], [1, 520, "#c8cbe0"], [1, 380, "#05d9e8"], [0, 0, ""], [0, 360, "#ff2a6d"], [1, 560, "#c8cbe0"], [1, 440, "#fcee0a"], [1, 500, "#c8cbe0"], [2, 320, "#05d9e8"], [2, 400, "#c8cbe0"], [0, 0, ""], [0, 300, "#ff2a6d"], [1, 600, "#c8cbe0"], [1, 260, "#7ee787"], [1, 480, "#c8cbe0"], [1, 340, "#c8cbe0"], [0, 0, ""], [0, 380, "#ff2a6d"], [1, 540, "#c8cbe0"], [1, 420, "#05d9e8"]];
    lines.forEach(([ind, w, col], i) => {
      g.fillStyle = "#4a4f66"; g.font = "14px Consolas, monospace"; g.fillText(String(i + 1).padStart(2, " "), 350, 176 + i * 33);
      if (w) { g.fillStyle = col; g.globalAlpha = 0.85; rr(394 + ind * 34, 163 + i * 33, w, 14, 7); g.fill(); g.globalAlpha = 1; }
    });
    if (Math.floor(t / 15) % 2) { g.fillStyle = "#fcee0a"; g.fillRect(394 + 34 + 430, 160 + 7 * 33, 3, 20); }
    // chart window
    g.shadowColor = "rgba(0,0,0,0.5)"; g.shadowBlur = 40; g.shadowOffsetY = 14;
    g.fillStyle = "#12141c"; rr(1230, 170, 580, 470, 14); g.fill();
    g.shadowColor = "transparent";
    g.fillStyle = "#1c1f2b"; rr(1230, 170, 580, 44, [14, 14, 0, 0]); g.fill();
    g.fillStyle = "#8b90a8"; g.font = "600 17px Segoe UI, sans-serif"; g.fillText("Turnier – Punktestand", 1254, 198);
    [[0.62, "#ff2a6d", "Team Neon"], [0.9, "#fcee0a", "Cyber Crew"], [0.48, "#05d9e8", "Nightfall"], [0.74, "#7ee787", "Pixelpiraten"]].forEach(([v, col, name], i) => {
      const h = 300 * v * (0.96 + 0.04 * Math.sin(t / 12 + i));
      g.fillStyle = col; rr(1280 + i * 128, 580 - h, 84, h, 10); g.fill();
      g.fillStyle = "#c8cbe0"; g.font = "600 15px Segoe UI, sans-serif"; g.fillText(name, 1272 + i * 128, 612);
    });
    // taskbar
    g.fillStyle = "rgba(10,10,20,0.78)"; g.fillRect(0, 1020, 1920, 60);
    ["#fcee0a", "#ff2a6d", "#05d9e8", "#7ee787", "#b388ff"].forEach((col, i) => { g.fillStyle = col; rr(820 + i * 58, 1034, 34, 34, 9); g.fill(); });
    g.fillStyle = "#e8e9f2"; g.font = "600 16px Segoe UI, sans-serif"; g.fillText("20:14", 1830, 1056);
    // mouse pointer
    const mx = 760 + Math.sin(t / 40) * 6, my = 400 + Math.cos(t / 40) * 4;
    g.fillStyle = "#fff"; g.strokeStyle = "#000"; g.lineWidth = 2;
    g.beginPath(); g.moveTo(mx, my); g.lineTo(mx, my + 26); g.lineTo(mx + 7, my + 20); g.lineTo(mx + 12, my + 31); g.lineTo(mx + 16, my + 29); g.lineTo(mx + 11, my + 18); g.lineTo(mx + 20, my + 18); g.closePath(); g.fill(); g.stroke();
  };
  draw();
  setInterval(draw, 66);
  window.__demo = c;
  return ${V}.publishScreen(c.captureStream(15), { monitor: true, capture: false });
})()`);
await waitFor(() => ev(me, `${V}.screens.value.has(arg)`, lenaId));
await waitFor(() => me.locator(".tile.screen video").first().evaluate((v) => v.videoWidth > 0));
// Give the video encoder time to reach full sharpness.
await waitFor(() => me.locator(".tile.screen video").first().evaluate((v) => v.videoWidth >= 1900), 40000).catch(() => {});
await sleep(6000);

// ---- 1. remote control: Lena is asked, then christian controls her screen
await ev(lena, `${V}.setRemote(true)`);
await waitFor(() => ev(me, `${V}.remoteOffers.value.has(arg)`, lenaId));
await ev(me, `${V}.requestControl(arg)`, lenaId);
await waitFor(() => lena.locator(".rc-request").count());
await sleep(400);
await shot(lena, "rc-ask");
await lena.locator(".rc-request .btn.primary").click();
await waitFor(() => me.locator(".rc-hud.active").count());
await me.mouse.move(700, 420);
await sleep(900);
await shot(me, "rc-control");
await shot(lena, "rc-host");
// host menu with the optional, hidden password
await lena.locator(".rc-banner .btn").click();
await ev(lena, `${V}.setRemote(true, { usePassword: true, password: "cyber-2026" })`);
await lena.locator(".tile.screen").first().click();
await lena.locator(".voice-controls .round-btn[title*='Fernsteuerung']").click();
await lena.waitForSelector(".rc-menu");
// The hint "desktop app only" belongs to this browser run, not to the app.
await lena.evaluate(() => document.querySelector(".rc-menu .notice.warn")?.remove());
await sleep(500);
await shot(lena, "rc-menu");
await lena.keyboard.press("Escape");
await ev(lena, `${V}.setRemote(false)`);

// ---- 2. drawing and laser pointer on the stream
await me.locator(".tile.screen").first().click();
await sleep(500);
const circle = (cx, cy, rx, ry) => Array.from({ length: 34 }, (_, i) => [cx + Math.cos((i / 31) * Math.PI * 2 - 1.2) * rx, cy + Math.sin((i / 31) * Math.PI * 2 - 1.2) * ry]);
const strokeOn = async (page, uid, pts) => {
  for (let i = 0; i < pts.length; i++) await ev(page, `${V}.ink.draw(arg.uid, arg.x, arg.y, arg.start)`, { uid, x: pts[i][0], y: pts[i][1], start: i === 0 });
  await ev(page, `${V}.ink.endStroke()`);
};
await strokeOn(me, lenaId, circle(0.78, 0.36, 0.085, 0.2));
await strokeOn(me, lenaId, [[0.52, 0.2], [0.56, 0.24], [0.6, 0.27], [0.63, 0.3], [0.66, 0.32], [0.68, 0.33]]);
await strokeOn(me, lenaId, [[0.64, 0.335], [0.68, 0.33], [0.672, 0.29]]);
await ev(lena, `(window.__nexus.inkTool.value = "pen", true)`);
await ev(lena, `(async () => { const m = await import("/src/rtc/ink.ts"); m.inkColor.value = "#ffb020"; return true; })()`);
await strokeOn(lena, lenaId, [[0.23, 0.385], [0.28, 0.39], [0.34, 0.386], [0.4, 0.39], [0.45, 0.387]]);
await ev(lena, `(window.__nexus.inkTool.value = "off", true)`);
await me.locator(".tile.screen").first().hover();
await me.locator(".tile-tools .icon-btn[title='Auf den Stream zeichnen']").click();
for (let i = 0; i < 6; i++) await ev(lena, `${V}.ink.point(arg, 0.335 + Math.random() * 0.002, 0.63)`, lenaId);
await sleep(500);
await ev(lena, `${V}.ink.point(arg, 0.336, 0.631)`, lenaId);
await sleep(250);
await shot(me, "ink");
await ev(me, `(window.__nexus.inkTool.value = "off", true)`);

// ---- 3. instant clip
await waitFor(() => ev(me, `${V}.clips.source.value === arg`, lenaId));
await sleep(5000);
await me.locator(".tile.screen").first().hover();
await me.locator(".tile-tools .icon-btn[title^='Clip der letzten Sekunden']").click();
await me.waitForSelector(".clip-preview");
await waitFor(() => me.locator(".clip-preview").evaluate((v) => v.videoWidth > 0));
await sleep(1200);
await shot(me, "clip");
await me.locator(".modal .btn.ghost").click();

// ---- 4. watch together: the menu with a recognised link
await me.locator(".voice-controls .round-btn[title='Gemeinsam schauen']").click();
await me.waitForSelector(".watch-menu");
await me.locator(".watch-menu input").fill("https://www.youtube.com/watch?v=aqz-KE-bpKQ");
await sleep(400);
await shot(me, "watch-menu");
await me.keyboard.press("Escape");

// ---- 5. encrypted direct messages
await ev(me, `window.__nexus.startDm(window.__nexus.servers.value[0], arg)`, lenaId);
await me.waitForSelector(".composer textarea");
const dmId = await ev(me, `window.__nexus.servers.value[0].dms.value.find((d) => d.user_id === arg).channel_id`, lenaId);
await waitFor(async () => (await ev(me, `window.__nexus.servers.value[0].e2e.myKid.value`)) && (await ev(lena, `window.__nexus.servers.value[0].e2e.myKid.value`)));
await ev(me, `(async () => { const s = window.__nexus.servers.value[0]; await s.e2e.fetchKeys(arg.uid, true); s.setE2e(arg.cid, true); return true; })()`, { uid: lenaId, cid: dmId });
const say = async (page, text) => {
  await page.locator(".composer textarea").fill(text);
  await page.keyboard.press("Enter");
  await sleep(350);
};
await say(me, "Hi Lena – ab jetzt ist unser Chat Ende-zu-Ende verschlüsselt 🔐");
await lena.locator(".rail .rail-btn.home").click();
await lena.locator(".chan", { hasText: "christian" }).first().click();
await lena.waitForSelector(".composer textarea");
await waitFor(() => ev(lena, `window.__nexus.servers.value[0].e2eOn(arg)`, dmId));
await say(lena, "Perfekt. Dann schick mir gleich das **WLAN-Passwort** fürs Turnier 😄");
await say(me, "Kommt: `cyber-crew-2026` – das kann jetzt nicht mal mehr der Server lesen.");
await say(lena, "Top! Und das Video vom Finale?");
await say(me, "18 GB … das geht per Direktversand, ohne Upload-Limit ⚡");
await waitFor(() => me.locator(".msg", { hasText: "Finale" }).count());
await sleep(600);

// ---- 6. direct transfer: a big file on its way (list state set for the picture)
await ev(me, `(async () => {
  const m = await import("/src/rtc/transfer.ts");
  const server = window.__nexus.servers.value[0];
  m.transfers.value = [
    { id: "a", server, peer: arg, dir: "send", name: "Turnier-Finale-4K.mkv", size: 18.4 * 2 ** 30, mime: "video/x-matroska", done: 6.9 * 2 ** 30, speed: 11.6 * 2 ** 20, state: "active" },
    { id: "b", server, peer: arg, dir: "recv", name: "Regelwerk-2026.pdf", size: 3.2 * 2 ** 20, mime: "application/pdf", done: 3.2 * 2 ** 20, speed: 0, state: "done" },
  ];
  return true;
})()`, lenaId);
await sleep(500);
await shot(me, "dm-e2e");
await me.locator(".main-head .icon-btn.sealed").click();
await me.waitForSelector(".e2e-number");
await sleep(500);
await shot(me, "e2e-dialog");
await me.locator(".modal-foot .btn").click();
// the receiving side: an offer waiting for an answer
await ev(lena, `(async () => {
  const m = await import("/src/rtc/transfer.ts");
  const server = window.__nexus.servers.value[0];
  m.transfers.value = [{ id: "a", server, peer: arg, dir: "recv", name: "Turnier-Finale-4K.mkv", size: 18.4 * 2 ** 30, mime: "video/x-matroska", done: 0, speed: 0, state: "offered" }];
  return true;
})()`, myId);
await sleep(500);
await shot(lena, "transfer-offer");

// ---- 7. the design picker with all designs
await ev(me, `(async () => { const m = await import("/src/rtc/transfer.ts"); m.transfers.value = []; return true; })()`);
await me.click(".user-panel .who");
await me.waitForSelector(".pane-nav");
await me.locator(".pane-nav button").nth(4).click();
await sleep(600);
await shot(me, "designs");

await browser.close();

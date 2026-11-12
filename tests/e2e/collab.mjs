// End-to-end test of the collaboration features of 0.10 in the real web UI:
// remote control (request, password, switch key, input messages), drawing and
// pointing on a stream, watching together, instant clips, direct file
// transfer without the server and end-to-end encrypted direct messages.
//
// Input injection itself is desktop-only (Windows SendInput) and covered by
// Rust unit tests; here the test checks what arrives at the host.
//
// Usage: node tests/e2e/collab.mjs   (requires `cargo build -p nexus-server`
// and the UI dev server: npm --prefix app run dev)

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7994;
const UDP = 3494;
const ADDR = `http://127.0.0.1:${PORT}`;
const UI = "http://localhost:5173";
const SHOTS = process.env.SHOTS_DIR || null;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
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
const shot = async (page, name) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, name) });
};

const dataDir = mkdtempSync(join(tmpdir(), "nx-collab-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = true\nudp_port = ${UDP}\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "domus-server.exe" : "domus-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });

async function api(path, body, token) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
function wsCall(token, op, d) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.re === 1) ws.send(JSON.stringify({ id: 2, op, d }));
      if (f.re === 2) {
        ws.close();
        f.ok ? res(f.d) : rej(f.err);
      }
    };
    ws.onerror = rej;
  });
}

async function openClient(browser, profile, token, username) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  await ctx.grantPermissions(["microphone", "camera"], { origin: UI });
  const cfg = { servers: [{ id: "srv", address: ADDR, fingerprint: null, name: "E2E", username, token }], settings: { notifications: false, uiSounds: false }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
  await ctx.addInitScript(([key, value]) => {
    localStorage.setItem(key, value);
    // No native "save as" dialog in the test: received files become downloads.
    delete window.showSaveFilePicker;
  }, [`nexustalk.config.${profile}`, JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${profile}] pageerror`, e.message));
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && console.log(`[${profile}] ${m.type()}`, m.text().slice(0, 300)));
  await page.goto(`${UI}/?profile=${profile}`);
  await page.waitForSelector(".chan .name", { timeout: 15000 });
  return page;
}
const joinVoice = (page) => page.locator(".chan", { hasText: "Allgemein" }).filter({ has: page.locator("svg") }).last().click();
const V = "window.__nexus.voice.value";
const ev = (page, expr, arg) => page.evaluate(new Function("arg", `return (${expr});`), arg);
function edgePath() {
  return [process.env.NEXUS_E2E_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => p && existsSync(p));
}

let browser;
try {
  if (!(await waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok))) throw new Error("server did not start");
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const a = await api("/api/v1/auth/register", { username: "alice", password: "testpass123", invite: setup });
  const inv = await wsCall(a.body.token, "invite.create", { max_uses: 5 });
  const b = await api("/api/v1/auth/register", { username: "bob", password: "testpass123", invite: inv.code });
  const c = await api("/api/v1/auth/register", { username: "carol", password: "testpass123", invite: inv.code });
  if (!(await waitFor(async () => (await fetch(UI)).ok, 3000))) throw new Error(`UI dev server not reachable at ${UI}`);

  browser = await chromium.launch({
    ...(edgePath() ? { executablePath: edgePath() } : {}),
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required", "--auto-select-desktop-capture-source=Entire screen"],
  });
  const pa = await openClient(browser, "alice", a.body.token, "alice");
  const pb = await openClient(browser, "bob", b.body.token, "bob");

  await joinVoice(pa);
  await waitFor(() => ev(pa, `${V}?.state.value === "connected"`));
  await joinVoice(pb);
  const aliceId = await waitFor(() => ev(pa, `${V}?.selfId`));
  const bobId = await waitFor(() => ev(pb, `${V}?.selfId`));
  const linked = await waitFor(async () => (await ev(pa, `[...${V}.peers.values()].every((p) => p.ctrl?.readyState === "open") && ${V}.peers.size === 1`)) && (await ev(pb, `[...${V}.peers.values()].every((p) => p.ctrl?.readyState === "open") && ${V}.peers.size === 1`)), 25000);
  check("call: data channel open between both", !!linked);

  // Everything alice receives on the data channel is recorded for the checks below.
  await ev(pa, `(window.__in = [], [...${V}.peers.values()].forEach((p) => p.ctrl.addEventListener("message", (e) => window.__in.push(JSON.parse(e.data)))), true)`);

  // ---------------------------------------------------------------- screen + remote control
  await ev(pa, `${V}.startScreen("monitor")`);
  const sharing = await waitFor(() => ev(pa, `${V}.sharingScreen.value`), 8000);
  const info = await ev(pa, `({ monitor: ${V}.screenIsMonitor.value, label: ${V}.screen?.getVideoTracks()[0]?.label, surface: ${V}.screen?.getVideoTracks()[0]?.getSettings().displaySurface })`);
  check("screen: whole-screen share detected", !!sharing && info.monitor === true, JSON.stringify(info));
  await waitFor(() => ev(pb, `${V}.screens.value.has(arg)`, aliceId), 15000);

  check("remote: not offered before the host allows it", (await ev(pb, `${V}.remoteOffers.value.size`)) === 0 && (await pb.locator(".tile-tools .icon-btn.accent").count()) === 0);
  await ev(pa, `${V}.setRemote(true)`);
  const offered = await waitFor(() => ev(pb, `${V}.remoteOffers.value.get(arg)`, aliceId));
  check("remote: offer announced without password", !!offered && offered.pw === false, JSON.stringify(offered));

  // No password → the host confirms the request.
  await pb.locator(".tile.screen").first().hover();
  await pb.locator(".tile-tools .icon-btn.accent").first().click();
  const asked = await waitFor(() => pa.locator(".rc-request").count());
  check("remote: host is asked to confirm", !!asked && (await ev(pa, `${V}.remoteRequest.value?.uid`)) === bobId);
  await shot(pa, "rc-request.png");
  await pa.locator(".rc-request .btn.primary").click();
  const granted = await waitFor(() => ev(pb, `${V}.controlling.value === arg && ${V}.controlActive.value`, aliceId));
  check("remote: granted after confirmation, control active", !!granted && (await ev(pa, `${V}.controlledBy.value`)) === bobId);
  check("remote: host sees the banner", (await pa.locator(".rc-banner").count()) === 1);
  await waitFor(() => pb.locator(".rc-hud.active").count());

  // Keyboard: physical keys as scan codes; the switch key is never forwarded.
  await sleep(400);
  await ev(pa, `(window.__in.length = 0, true)`);
  await pb.keyboard.press("KeyY");
  await pb.keyboard.press("ArrowUp");
  const keys = await waitFor(async () => {
    const k = (await ev(pa, `window.__in.filter((m) => m.t === "i").flatMap((m) => m.c).filter((c) => c.t === "k")`)) ?? [];
    return k.length >= 4 ? k : null;
  });
  check("remote: keys arrive as scan codes (Y = 0x15, ArrowUp = 0x48 extended)", !!keys && keys[0].s === 0x15 && keys[0].d === true && keys[1].s === 0x15 && keys[1].d === false && keys[2].s === 0x48 && keys[2].e === true, JSON.stringify(keys));

  // Mouse: position normalized to the picture, click with position first.
  await ev(pa, `(window.__in.length = 0, true)`);
  const box = await pb.locator(".rc-surface").boundingBox();
  await pb.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await pb.mouse.down();
  await pb.mouse.up();
  const mouse = await waitFor(async () => {
    const cmds = (await ev(pa, `window.__in.filter((m) => m.t === "i").flatMap((m) => m.c)`)) ?? [];
    return cmds.some((c) => c.t === "b" && c.d === false) ? cmds : null;
  });
  const mv = mouse?.find((c) => c.t === "m");
  const downIdx = mouse?.findIndex((c) => c.t === "b" && c.d);
  check("remote: mouse move + click arrive, centred", !!mv && Math.abs(mv.x - 0.5) < 0.05 && Math.abs(mv.y - 0.5) < 0.08 && downIdx > 0 && mouse[downIdx - 1].t === "m", JSON.stringify(mouse?.slice(0, 6)));
  await shot(pb, "rc-active.png");

  // F8 switches to my own PC: nothing is forwarded any more; F8 again takes over.
  await pb.keyboard.press("F8");
  const paused = await waitFor(() => ev(pb, `${V}.controlActive.value === false`));
  await ev(pa, `(window.__in.length = 0, true)`);
  await pb.keyboard.press("KeyQ");
  await sleep(400);
  const leaked = await ev(pa, `window.__in.filter((m) => m.t === "i").length`);
  check("remote: F8 pauses control, keys stay local", !!paused && leaked === 0 && (await pb.locator(".rc-surface").count()) === 0, `leaked ${leaked}`);
  await shot(pb, "rc-paused.png");
  await sleep(250);
  await pb.keyboard.press("F8");
  check("remote: F8 again takes over", !!(await waitFor(() => ev(pb, `${V}.controlActive.value === true`))));

  // A key still held when control ends is released on the host.
  await ev(pa, `(window.__in.length = 0, true)`);
  await pb.keyboard.down("ShiftLeft");
  await sleep(200);
  await pb.keyboard.press("F8");
  const released = await waitFor(async () => (await ev(pa, `window.__in.filter((m) => m.t === "i").flatMap((m) => m.c).filter((c) => c.t === "k" && c.s === 0x2a)`))?.some((c) => c.d === false));
  await pb.keyboard.up("ShiftLeft");
  check("remote: held keys are released when control pauses", !!released);

  // Host ends it.
  await pa.locator(".rc-banner .btn").click();
  const revoked = await waitFor(() => ev(pb, `${V}.controlling.value === null`));
  check("remote: host can end control at once", !!revoked && (await ev(pa, `${V}.controlledBy.value`)) === null);

  // With a password: wrong one is refused, the right one grants without asking.
  await ev(pa, `${V}.setRemote(true, { usePassword: true, password: "geheim-123" })`);
  await waitFor(() => ev(pb, `${V}.remoteOffers.value.get(arg)?.pw === true`, aliceId));
  await ev(pb, `${V}.requestControl(arg, "falsch")`, aliceId);
  const refused = await waitFor(async () => (await pb.locator(".toast").allInnerTexts()).join(" ").includes("Passwort stimmt nicht"));
  check("remote: wrong password refused", !!refused && (await ev(pb, `${V}.controlling.value`)) === null);
  await ev(pb, `${V}.requestControl(arg, "geheim-123")`, aliceId);
  const pwOk = await waitFor(() => ev(pb, `${V}.controlling.value === arg`, aliceId));
  check("remote: right password grants without confirmation", !!pwOk && (await pa.locator(".rc-request").count()) === 0);
  await ev(pb, `${V}.releaseControl()`);
  await waitFor(() => ev(pa, `${V}.controlledBy.value === null`));
  // The password field hides what is typed.
  await pa.locator(".voice-controls .round-btn[title*='Fernsteuerung']").click();
  const masked = await pa.locator(".rc-menu .pw-wrap input").evaluate((el) => getComputedStyle(el).webkitTextSecurity);
  check("remote: password field is masked", masked === "disc", masked);
  await shot(pa, "rc-menu.png");
  await pa.keyboard.press("Escape");
  await ev(pa, `${V}.setRemote(false)`);
  check("remote: offer withdrawn when switched off", !!(await waitFor(() => ev(pb, `${V}.remoteOffers.value.size === 0`))));

  // ---------------------------------------------------------------- drawing + laser pointer
  await pb.locator(".tile.screen").first().hover();
  await pb.locator(".tile-tools .icon-btn[title='Auf den Stream zeichnen']").click();
  const canvas = await pb.locator(".ink-layer.tool-pen").boundingBox();
  await pb.mouse.move(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.3);
  await pb.mouse.down();
  for (let i = 1; i <= 12; i++) await pb.mouse.move(canvas.x + canvas.width * (0.2 + i * 0.04), canvas.y + canvas.height * (0.3 + Math.sin(i / 2) * 0.1));
  await pb.mouse.up();
  const stroke = await waitFor(() => ev(pa, `(${V}.ink.strokes.get(arg.a) ?? []).find((s) => s.from === arg.b && s.done && s.pts.length >= 20)`, { a: aliceId, b: bobId }));
  check("ink: bob's stroke appears on alice's own stream", !!stroke && Math.abs(stroke.pts[0] - 0.2) < 0.03 && Math.abs(stroke.pts[1] - 0.3) < 0.04, stroke ? `${stroke.pts.length / 2} points, start ${stroke.pts[0].toFixed(2)}/${stroke.pts[1].toFixed(2)}` : "");
  await shot(pb, "ink-pen.png");
  await pb.locator(".tile-tools .icon-btn[title='Laserpointer']").click();
  const lc = await pb.locator(".ink-layer.tool-laser").boundingBox();
  await pb.mouse.move(lc.x + lc.width * 0.7, lc.y + lc.height * 0.6);
  await pb.mouse.move(lc.x + lc.width * 0.71, lc.y + lc.height * 0.61);
  const ptr = await waitFor(() => ev(pa, `[...(${V}.ink.pointers.get(arg.a)?.values() ?? [])].find((p) => p.name === "bob")`, { a: aliceId }));
  check("ink: laser pointer with name arrives", !!ptr && Math.abs(ptr.x - 0.71) < 0.04, JSON.stringify(ptr));
  await shot(pa, "ink-host.png");
  await ev(pb, `(window.__nexus.inkTool.value = "off", true)`);
  // The sharer forbids annotations: bob's tools disappear and marks are ignored.
  await ev(pa, `(window.__nexus.updateSettings({ allowInk: false }), ${V}.announceStream(), true)`);
  const noInk = await waitFor(() => ev(pb, `${V}.inkAllowed.value.get(arg) === false`, aliceId));
  const before = await ev(pa, `(${V}.ink.strokes.get(arg) ?? []).length`, aliceId);
  await ev(pb, `(${V}.broadcast({ t: "ink", s: arg, i: 99, p: [1000, 1000, 2000, 2000], e: 1 }), true)`, aliceId);
  await sleep(500);
  check("ink: sharer can switch annotations off", !!noInk && (await ev(pa, `(${V}.ink.strokes.get(arg) ?? []).length`, aliceId)) === before);
  await ev(pa, `(window.__nexus.updateSettings({ allowInk: true }), ${V}.announceStream(), true)`);

  // ---------------------------------------------------------------- instant clip
  const buffering = await waitFor(() => ev(pb, `${V}.clips.source.value === arg`, aliceId), 8000);
  await sleep(3500);
  const clip = await ev(pb, `${V}.clips.capture().then((c) => c && { size: c.blob.size, type: c.blob.type, seconds: c.seconds, name: c.name })`);
  check("clip: buffer runs for the watched stream and yields a video", !!buffering && !!clip && clip.size > 20000 && clip.type.startsWith("video/"), JSON.stringify(clip));
  const noticed = await waitFor(async () => (await pa.locator(".toast").allInnerTexts()).join(" ").includes("hat einen Clip erstellt"), 4000);
  check("clip: the others are told", !!noticed);
  await pb.locator(".tile.screen").first().hover();
  await pb.locator(".tile-tools .icon-btn[title^='Clip der letzten Sekunden']").click();
  const dlg = await waitFor(() => pb.locator(".clip-preview").count(), 8000);
  check("clip: dialog with preview, save and share", !!dlg && (await pb.locator(".clip-share select").count()) === 1);
  await shot(pb, "clip-dialog.png");
  await pb.locator(".modal .btn.ghost").click();

  // ---------------------------------------------------------------- watch together
  await ev(pa, `${V}.stopScreen()`);
  await waitFor(() => ev(pb, `!${V}.screens.value.has(arg)`, aliceId));
  check("watch: link parsing", (await ev(pa, `${V}.watch.start("kein link")`)) === false);
  await ev(pa, `${V}.watch.start("https://www.youtube.com/watch?v=aqz-KE-bpKQ&t=1m5s")`);
  const st = await waitFor(() => ev(pb, `${V}.watch.state.value`));
  check("watch: video started for everyone", !!st && st.kind === "yt" && st.src === "aqz-KE-bpKQ" && st.playing && Math.abs(st.pos - 65) < 2 && st.by === aliceId, JSON.stringify(st));
  check("watch: player tile shown on both sides", !!(await waitFor(() => pb.locator(".watch-tile iframe").count())) && (await pa.locator(".watch-tile iframe").count()) === 1);
  await ev(pb, `${V}.watch.update({ playing: false })`);
  const pausedAll = await waitFor(() => ev(pa, `${V}.watch.state.value?.playing === false`));
  check("watch: pause by bob applies to alice", !!pausedAll);
  await ev(pa, `${V}.watch.update({ pos: 300, playing: true })`);
  const seeked = await waitFor(async () => {
    const p = await ev(pb, `${V}.watch.state.value?.playing ? ${V}.watch.position() : -1`);
    return p >= 300 && p < 306 ? p : null;
  });
  check("watch: seek + play applies to bob, position advances", !!seeked, `bob at ${seeked?.toFixed?.(1)} s`);
  // A third person joining later gets the running video.
  const pc3 = await openClient(browser, "carol", c.body.token, "carol");
  await joinVoice(pc3);
  const late = await waitFor(() => ev(pc3, `${V}?.watch.state.value && ${V}.watch.position()`), 25000);
  check("watch: late joiner gets the running video at the right position", !!late && late > 300 && late < 330, `carol at ${late?.toFixed?.(1)} s`);
  await sleep(1500);
  await shot(pb, "watch.png");
  await ev(pb, `${V}.watch.stop()`);
  check("watch: ending it ends it for everyone", !!(await waitFor(async () => (await ev(pa, `${V}.watch.state.value === null`)) && (await ev(pc3, `${V}.watch.state.value === null`)))));

  // A local video file is played for everyone as a stream.
  const filePlayed = await ev(pa, `(async () => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 180;
    const g = c.getContext("2d"); let n = 0;
    const draw = setInterval(() => { g.fillStyle = "hsl(" + (n++ * 9) + ",80%,50%)"; g.fillRect(0, 0, 320, 180); }, 40);
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: "video/webm" });
    const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
    rec.start(); await new Promise((r) => setTimeout(r, 1800)); rec.stop();
    await new Promise((r) => (rec.onstop = r)); clearInterval(draw);
    const file = new File(parts, "testfilm.webm", { type: "video/webm" });
    return window.__nexus.playFileForAll(${V}, file);
  })()`);
  const fileSeen = await waitFor(() => ev(pb, `${V}.screens.value.has(arg)`, aliceId), 15000);
  const fileFrames = await waitFor(() => pb.locator(".tile.screen video").first().evaluate((v) => v.videoWidth > 0), 10000);
  check("file: local video plays for everyone as a stream", filePlayed === true && !!fileSeen && !!fileFrames && (await ev(pa, `${V}.screenIsFile.value`)) === true);
  check("file: no remote control for a played file", (await ev(pa, `(${V}.setRemote(true), ${V}.remoteAllowed.value)`)) === false);
  await ev(pa, `${V}.stopScreen()`);

  // ---------------------------------------------------------------- direct file transfer
  const SIZE = 6 * 1024 * 1024 + 1234;
  const sentHash = await ev(pa, `(async () => {
    const bytes = new Uint8Array(arg.size);
    for (let o = 0; o < bytes.length; o += 65536) crypto.getRandomValues(bytes.subarray(o, Math.min(o + 65536, bytes.length)));
    const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    await window.__nexus.offerFile(window.__nexus.servers.value[0], arg.to, new File([bytes], "groß & wichtig.bin"));
    return h;
  })()`, { size: SIZE, to: bobId });
  const offer = await waitFor(() => pb.locator(".xfer-card.offered").count());
  check("transfer: offer shows up at bob", !!offer && (await pb.locator(".xfer-name").first().innerText()) === "groß & wichtig.bin");
  await shot(pb, "transfer-offer.png");
  const [download] = await Promise.all([pb.waitForEvent("download", { timeout: 60000 }), pb.locator(".xfer-card.offered .btn.primary").click()]);
  const path = await download.path();
  const got = readFileSync(path);
  const gotHash = createHash("sha256").update(got).digest("hex");
  check("transfer: file arrives complete and identical", got.length === SIZE && gotHash === sentHash, `${got.length} bytes`);
  const bothDone = await waitFor(async () => (await ev(pa, `window.__nexus.transfers.value[0]?.state`)) === "done" && (await ev(pb, `window.__nexus.transfers.value[0]?.state`)) === "done");
  check("transfer: both sides report done", !!bothDone);
  await shot(pa, "transfer-done.png");
  // Declining and offline targets.
  await ev(pa, `window.__nexus.offerFile(window.__nexus.servers.value[0], arg, new File(["x"], "nein.txt"))`, bobId);
  await waitFor(() => pb.locator(".xfer-card.offered").count());
  check("transfer: finished entries leave the 'offered' state in the list", (await pb.locator(".xfer-card.offered").count()) === 1 && (await pb.locator(".xfer-card.done").count()) === 1);
  await pb.locator(".xfer-card.offered .btn.ghost").click();
  check("transfer: declining reaches the sender", !!(await waitFor(() => ev(pa, `window.__nexus.transfers.value.some((t) => t.name === "nein.txt" && t.state === "declined")`))));

  // ---------------------------------------------------------------- end-to-end encrypted DM
  const keys2 = await waitFor(async () => (await ev(pa, `window.__nexus.servers.value[0].e2e.myKid.value`)) && (await ev(pb, `window.__nexus.servers.value[0].e2e.myKid.value`)));
  check("e2e: both devices created and published a key", !!keys2);
  await ev(pa, `window.__nexus.startDm(window.__nexus.servers.value[0], arg)`, bobId);
  await pa.waitForSelector(".composer textarea");
  const dmId = await ev(pa, `window.__nexus.servers.value[0].dms.value.find((d) => d.user_id === arg).channel_id`, bobId);
  await pa.locator(".composer textarea").fill("noch im Klartext");
  await pa.keyboard.press("Enter");
  await pa.locator(".main-head .icon-btn[title='Verschlüsselung für diese Unterhaltung']").click();
  await pa.waitForSelector(".e2e-state");
  await shot(pa, "e2e-dialog.png");
  await pa.locator(".modal .toggle").click();
  check("e2e: switched on in the dialog, security number shown", (await ev(pa, `window.__nexus.servers.value[0].e2eOn(arg)`, dmId)) === true && /^([0-9A-F]{4} ){7}[0-9A-F]{4}$/.test(await pa.locator(".e2e-number").innerText()));
  const numberA = await pa.locator(".e2e-number").innerText();
  await pa.locator(".modal-foot .btn").click();
  await pa.locator(".composer textarea").fill("streng geheim 🔐 äöü");
  await pa.keyboard.press("Enter");
  const raw = await waitFor(async () => {
    const h = await wsCall(a.body.token, "message.history", { channel_id: dmId, limit: 10 });
    return h.messages.length >= 2 ? h.messages : null;
  });
  check("e2e: the server only stores ciphertext", !!raw && raw[0].content === "noch im Klartext" && raw[1].content.startsWith("nxe1.") && !raw[1].content.includes("geheim"), raw?.[1].content.slice(0, 60));
  // Bob opens the DM: readable, marked as encrypted, and his side switches on by itself.
  await pb.locator(".rail .rail-btn.home").click();
  await pb.locator(".chan", { hasText: "alice" }).first().click();
  const readable = await waitFor(() => pb.locator(".msg", { hasText: "streng geheim 🔐 äöü" }).count());
  check("e2e: bob reads the message, lock shown", !!readable && (await pb.locator(".msg-lock").count()) >= 1);
  const autoOn = await waitFor(() => ev(pb, `window.__nexus.servers.value[0].e2eOn(arg)`, dmId));
  await pb.locator(".composer textarea").fill("Antwort, auch geheim");
  await pb.keyboard.press("Enter");
  const reply = await waitFor(() => pa.locator(".msg", { hasText: "Antwort, auch geheim" }).count());
  const raw2 = (await wsCall(a.body.token, "message.history", { channel_id: dmId, limit: 10 })).messages;
  check("e2e: bob's reply is encrypted automatically and alice reads it", !!autoOn && !!reply && raw2[2].content.startsWith("nxe1."));
  await pb.locator(".main-head .icon-btn.sealed").click();
  await pb.waitForSelector(".e2e-number");
  check("e2e: both see the same security number", (await pb.locator(".e2e-number").innerText()) === numberA);
  await pb.locator(".modal-foot .btn").click();
  // Editing keeps the message encrypted.
  const mid = raw2[1].id;
  await ev(pa, `(async () => { const s = window.__nexus.servers.value[0]; await s.rpc("message.edit", { message_id: arg.mid, content: await s.seal(arg.cid, "bearbeitet & geheim", true) }); return true; })()`, { mid, cid: dmId });
  const edited = await waitFor(() => pb.locator(".msg", { hasText: "bearbeitet & geheim" }).count());
  const raw3 = (await wsCall(a.body.token, "message.history", { channel_id: dmId, limit: 10 })).messages;
  check("e2e: an edited message stays encrypted", !!edited && raw3[1].content.startsWith("nxe1."));
  // Key backup: export, then decrypt with the restored key on a "new device".
  const backup = await ev(pa, `window.__nexus.servers.value[0].e2e.exportKeys("sicherung-123")`);
  const restored = await ev(pb, `(async () => {
    const { E2e } = await import("/src/crypto/e2e.ts");
    const s = window.__nexus.servers.value[0];
    const fake = { id: "other-device", saved: { value: { fingerprint: "ff".repeat(16) } }, me: { value: { id: arg.alice } }, conn: { ready: false }, rpc: (op, d) => s.rpc(op, d) };
    const e = new E2e(fake);
    let wrong = false;
    try { await e.importKeys("falsches kennwort", arg.backup); } catch { wrong = true; }
    await e.importKeys("sicherung-123", arg.backup);
    const r = await e.decrypt(arg.content, arg.bob, true);
    return { wrong, text: r.text ?? null };
  })()`, { backup, content: raw3[1].content, alice: aliceId, bob: bobId });
  check("e2e: key backup restores readability, wrong passphrase refused", restored.wrong === true && restored.text === "bearbeitet & geheim", JSON.stringify(restored));
  // Without the key a message is shown as unreadable instead of garbage.
  const unreadable = await ev(pb, `(async () => {
    const s = window.__nexus.servers.value[0];
    const [m] = await s.open([{ id: 1, channel_id: arg.cid, author_id: arg.alice, content: "nxe1.0123456789abcdef.0123456789abcdef.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA", reply_to: null, created_at: 0, edited_at: null, mentions: [], attachments: [], reactions: [], pinned_at: null }]);
    return { e2e: m.e2e, content: m.content };
  })()`, { cid: dmId, alice: aliceId });
  check("e2e: a message for an unknown key is marked unreadable", unreadable.e2e === "fail" && unreadable.content === "");
  await shot(pb, "e2e-chat.png");
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(ROOT, "tests", "e2e", "collab-last-run.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

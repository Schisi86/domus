// End-to-end test of real-time media between browser clients.
//
// Starts a fresh headless NexusTalk server, registers three users and drives
// the real web UI in Microsoft Edge (Playwright) with Chromium's fake
// microphone/camera/screen devices. Verifies:
//   1. audio connection between two clients (bytes flowing, speaker detection)
//   2. screen sharing from A to B (frames decoded), then stopping it
//   3. a third participant (3-way mesh)
//   4. media survives a server restart (signaling reconnect, voice seat grace)
//   5. leave + rejoin re-establishes the media connection
//   6. a guest without SCREEN_SHARE permission is refused by the server
//
// Usage: node tests/e2e/rtc.mjs   (requires `cargo build -p nexus-server`)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7990;
const UDP = 3490;
const ADDR = `http://127.0.0.1:${PORT}`;
const UI = "http://localhost:5173";
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
}

async function waitFor(fn, timeout = 20000, step = 250) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(step);
  }
  return null;
}

// ------------------------------------------------------------- server

const dataDir = mkdtempSync(join(tmpdir(), "nx-e2e-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = true\nudp_port = ${UDP}\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "domus-server.exe" : "domus-server");
let server;
function startServer() {
  server = spawn(exe, ["--data", dataDir], { stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});
}
async function serverUp() {
  return waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok, 15000);
}

async function api(path, body, token) {
  const r = await fetch(ADDR + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
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

// ------------------------------------------------------------- UI helpers

async function openClient(browser, profile, token, username) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.grantPermissions(["microphone", "camera"], { origin: UI });
  const cfg = { servers: [{ id: "srv", address: ADDR, fingerprint: null, name: "E2E", username, token }], settings: { notifications: false }, host_autostart: false, minimize_to_tray: true };
  await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), [`nexustalk.config.${profile}`, JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${profile}] pageerror`, e.message));
  await page.goto(`${UI}/?profile=${profile}`);
  await page.waitForSelector(".chan .name", { timeout: 15000 });
  return page;
}

const joinVoice = (page) => page.locator(".chan", { hasText: "Allgemein" }).filter({ has: page.locator("svg") }).last().click();

/** Inbound RTP totals of the page's voice session, per kind. */
function inbound(page) {
  return page.evaluate(async () => {
    const v = window.__nexus.voice.value;
    if (!v) return null;
    const out = { audioBytes: 0, videoFrames: 0, connected: 0, peers: 0 };
    for (const p of v.peers.values()) {
      out.peers++;
      if (p.pc.connectionState === "connected") out.connected++;
      const st = await p.pc.getStats();
      st.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") out.audioBytes += s.bytesReceived ?? 0;
        if (s.type === "inbound-rtp" && s.kind === "video") out.videoFrames += s.framesDecoded ?? 0;
      });
    }
    return out;
  });
}

function edgePath() {
  const candidates = [process.env.NEXUS_E2E_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return candidates.find((p) => p && existsSync(p));
}

// ------------------------------------------------------------- run

let browser;
try {
  startServer();
  if (!(await serverUp())) throw new Error("server did not start");
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const a = await api("/api/v1/auth/register", { username: "alice", password: "testpass123", invite: setup });
  const inv = await wsCall(a.body.token, "invite.create", { max_uses: 5 });
  const b = await api("/api/v1/auth/register", { username: "bob", password: "testpass123", invite: inv.code });
  const c = await api("/api/v1/auth/register", { username: "carol", password: "testpass123", invite: inv.code });
  const roles = (await wsCall(a.body.token, "invite.list", {})) && null;
  void roles;
  check("users registered", a.status === 200 && b.status === 200 && c.status === 200);

  const uiUp = await waitFor(async () => (await fetch(UI)).ok, 3000).catch(() => null);
  if (!uiUp) throw new Error(`UI dev server not reachable at ${UI} (run: npm --prefix app run dev)`);

  browser = await chromium.launch({
    ...(edgePath() ? { executablePath: edgePath() } : {}),
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const pa = await openClient(browser, "alice", a.body.token, "alice");
  const pb = await openClient(browser, "bob", b.body.token, "bob");

  // 1. Audio between two clients
  await joinVoice(pa);
  await waitFor(() => pa.evaluate(() => window.__nexus.voice.value?.state.value === "connected"));
  await joinVoice(pb);
  const conn = await waitFor(async () => {
    const [x, y] = [await inbound(pa), await inbound(pb)];
    return x?.connected === 1 && y?.connected === 1 ? [x, y] : null;
  });
  check("audio: peer connection established (2 clients)", !!conn);
  const s1 = await inbound(pb);
  await sleep(2500);
  const s2 = await inbound(pb);
  check("audio: bytes flowing A→B", s2 && s1 && s2.audioBytes > s1.audioBytes + 2000, `${s1?.audioBytes} → ${s2?.audioBytes} bytes`);
  const sa = await inbound(pa);
  check("audio: bytes flowing B→A", sa && sa.audioBytes > 2000, `${sa?.audioBytes} bytes`);
  const aliceId = await pa.evaluate(() => window.__nexus.voice.value.selfId);
  const bobId = await pb.evaluate(() => window.__nexus.voice.value.selfId);
  const spoke = await waitFor(() => pb.evaluate((id) => window.__nexus.voice.value.speaking.value.has(id), aliceId), 8000, 100);
  check("audio: active speaker detected", !!spoke);
  const quality = await pb.evaluate(() => [...window.__nexus.voice.value.stats.value.values()][0]);
  check("stats: RTT measured", quality && quality.rtt !== null, JSON.stringify(quality));

  // Mute: track disabled → server state muted
  await pa.evaluate(() => window.__nexus.voice.value.setMuted(true));
  const mutedSeen = await waitFor(() => pb.evaluate((id) => window.__nexus.servers.value[0].voice.value.get(id)?.muted, aliceId));
  check("mute state propagated", !!mutedSeen);
  await pa.evaluate(() => window.__nexus.voice.value.setMuted(false));

  // 2. Screen sharing A → B
  await pa.evaluate(() => window.__nexus.voice.value.startScreen());
  const sharing = await waitFor(() => pa.evaluate(() => window.__nexus.voice.value.sharingScreen.value), 8000);
  check("screen: capture started on A", !!sharing);
  const gotScreen = await waitFor(() => pb.evaluate((id) => window.__nexus.voice.value.screens.value.has(id), aliceId), 15000);
  check("screen: stream received on B", !!gotScreen);
  const f1 = (await inbound(pb))?.videoFrames ?? 0;
  await sleep(2500);
  const f2 = (await inbound(pb))?.videoFrames ?? 0;
  check("screen: frames decoded on B", f2 > f1 && f2 > 5, `${f1} → ${f2} frames`);
  const tile = await pb.locator(".tile video").first().evaluate((v) => v.videoWidth).catch(() => 0);
  check("screen: rendered in B's UI", tile > 0, `videoWidth=${tile}`);
  await pa.evaluate(() => window.__nexus.voice.value.stopScreen());
  const gone = await waitFor(() => pb.evaluate((id) => !window.__nexus.voice.value.screens.value.has(id), aliceId), 10000);
  check("screen: stopped and removed on B", !!gone);

  // 2b. Webcam A → B
  await pa.evaluate(() => window.__nexus.voice.value.startCamera());
  const gotCam = await waitFor(() => pb.evaluate((id) => window.__nexus.voice.value.cameras.value.has(id), aliceId), 15000);
  check("camera: stream received on B", !!gotCam);
  await pa.evaluate(() => window.__nexus.voice.value.stopCamera());
  const camGone = await waitFor(() => pb.evaluate((id) => !window.__nexus.voice.value.cameras.value.has(id), aliceId), 10000);
  check("camera: turned off and removed on B", !!camGone);

  // 3. Third participant
  const pc3 = await openClient(browser, "carol", c.body.token, "carol");
  await joinVoice(pc3);
  const mesh = await waitFor(async () => {
    const all = await Promise.all([pa, pb, pc3].map(inbound));
    return all.every((x) => x?.connected === 2) ? all : null;
  }, 25000);
  check("mesh: 3 participants fully connected", !!mesh, mesh ? mesh.map((x) => `${x.connected}/${x.peers}`).join(" ") : "");

  // 4. Server restart during a call
  const before = (await inbound(pb))?.audioBytes ?? 0;
  server.kill();
  await sleep(1500);
  startServer();
  await serverUp();
  const rejoined = await waitFor(() => pb.evaluate(() => window.__nexus.voice.value?.state.value === "connected" && window.__nexus.servers.value[0].conn.state.value === "ready"), 25000);
  check("restart: signaling reconnected and voice seat restored", !!rejoined);
  await sleep(2000);
  const after = await inbound(pb);
  check("restart: media kept flowing", after && after.audioBytes > before && after.connected >= 1, `${before} → ${after?.audioBytes} bytes, ${after?.connected} peers`);

  // 5. Leave and rejoin
  await pb.evaluate(() => window.__nexus.voice.value.leave().then(() => (window.__nexus.voice.value = null)));
  const left = await waitFor(() => pa.evaluate((id) => !window.__nexus.servers.value[0].voice.value.has(id), bobId), 10000);
  check("leave: others see participant leave", !!left);
  await joinVoice(pb);
  const back = await waitFor(async () => (await inbound(pb))?.connected === 2, 20000);
  check("rejoin: media connections re-established", !!back);

  // 6. Server-side permission check for screen sharing (guest role)
  const guestRole = (await wsCall(a.body.token, "server.settings", {})) && (await (async () => {
    const r = await new Promise((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token: a.body.token } }));
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data);
        if (f.re === 1) {
          ws.close();
          res(f.d.guild.roles.find((x) => x.name === "Gast").id);
        }
      };
    });
    return r;
  })());
  const gi = await wsCall(a.body.token, "invite.create", { role_id: guestRole });
  const g = await api("/api/v1/auth/register", { username: "gast", password: "testpass123", invite: gi.code });
  const pg = await openClient(browser, "gast", g.body.token, "gast");
  await joinVoice(pg);
  await waitFor(() => pg.evaluate(() => window.__nexus.voice.value?.state.value === "connected"));
  await pg.evaluate(() => window.__nexus.voice.value.startScreen());
  await sleep(1500);
  const guestSharing = await pg.evaluate(() => window.__nexus.voice.value.sharingScreen.value);
  const toastText = await pg.locator(".toast").allInnerTexts();
  check("permissions: guest screen share refused", !guestSharing && toastText.join(" ").includes("nicht erlaubt"), toastText.join(" | "));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  server?.kill();
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(ROOT, "tests", "e2e", "last-run.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

// Reproducible resource benchmark for the server and the WebRTC media path.
//
//   node tests/bench/bench.mjs
//
// Requires a release build of the headless server (cargo build --release -p nexus-server)
// and, for the media part, the UI dev server (npm --prefix app run dev) plus the
// Playwright Chromium used by tests/e2e.
//
// Measures (Windows, via Get-Process / CIM):
//   server: idle RSS, RSS + CPU with 100 connected clients sending 1 msg/s
//   media : CPU/RAM of two headless Chromium clients idle, in a voice call, and
//           with a 720p/1080p screen share (fake capture device)

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7991;
const ADDR = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { date: new Date().toISOString(), cpu: cpus()[0]?.model, cores: cpus().length, server: {}, media: {} };

/** Working set (MB) and total CPU seconds for a set of process ids. */
function procStats(pids) {
  if (!pids.length) return { mb: 0, cpu: 0 };
  const ws = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`]).toString().trim();
  const cpu = execFileSync("powershell", ["-NoProfile", "-Command", `((Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue) | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum`]).toString().trim();
  return { mb: Math.round((Number(ws) / 1048576) * 10) / 10, cpu: Number(cpu.replace(",", ".")) };
}

async function cpuPercent(pidsFn, seconds) {
  const a = procStats(pidsFn());
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const b = procStats(pidsFn());
  const wall = (Date.now() - t0) / 1000;
  // Percent of one core and of the whole machine.
  return { core_pct: Math.round(((b.cpu - a.cpu) / wall) * 1000) / 10, machine_pct: Math.round(((b.cpu - a.cpu) / wall / cpus().length) * 1000) / 10, mb: b.mb };
}

async function api(path, body, token) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return r.json();
}

function client(token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    let id = 1;
    const c = { ws, ready: null, send: (op, d) => ws.send(JSON.stringify({ id: ++id, op, d })) };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.re === 1) f.ok ? ((c.ready = f.d), res(c)) : rej(f.err);
    };
    ws.onerror = rej;
  });
}

// ------------------------------------------------------------- server

const exe = join(ROOT, "target", "release", "domus-server.exe");
if (!existsSync(exe)) {
  console.error("Release server missing: cargo build --release -p nexus-server");
  process.exit(1);
}
const dataDir = mkdtempSync(join(tmpdir(), "nx-bench-"));
writeFileSync(
  join(dataDir, "server.toml"),
  `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = false\n[limits]\nauth_per_min = 100000.0\nauth_burst = 100000.0\nmax_connections_per_ip = 1000\n`,
);
const srv = spawn(exe, ["--data", dataDir], { stdio: "ignore" });
for (let i = 0; i < 50 && !(await fetch(`${ADDR}/api/v1/info`).then((r) => r.ok, () => false)); i++) await sleep(200);
await sleep(3000);
out.server.idle = await cpuPercent(() => [srv.pid], 10);
console.log("server idle", out.server.idle);

const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
const owner = await api("/api/v1/auth/register", { username: "owner", password: "benchpass1", invite: setup });
const oc = await client(owner.token);
const invite = await new Promise((res) => {
  oc.ws.onmessage = (ev) => {
    const f = JSON.parse(ev.data);
    if (f.re === 2) res(f.d.code);
  };
  oc.send("invite.create", { max_uses: 10000, expires_hours: 24 });
});
const N = 100;
const clients = [];
for (let i = 0; i < N; i++) {
  const r = await api("/api/v1/auth/register", { username: `user${i}`, password: "benchpass1", invite });
  clients.push(await client(r.token));
}
const general = clients[0].ready.guild.channels.find((c) => c.kind === "text").id;
out.server.connected_idle = await cpuPercent(() => [srv.pid], 10);
console.log(`server with ${N} idle connections`, out.server.connected_idle);
let n = 0;
const timer = setInterval(() => {
  for (const c of clients) c.send("message.send", { channel_id: general, content: `Lastnachricht ${n++}` });
}, 1000);
await sleep(2000);
out.server.load = await cpuPercent(() => [srv.pid], 15);
out.server.load.description = `${N} clients, each sending 1 message/s; every message fans out to all ${N + 1} connections`;
clearInterval(timer);
console.log("server under load", out.server.load);
for (const c of clients) c.ws.close();
oc.ws.close();

// ------------------------------------------------------------- media (two headless Chromium clients)

const uiUp = await fetch("http://localhost:5173").then((r) => r.ok, () => false);
if (uiUp) {
  const { chromium } = await import("../e2e/node_modules/playwright-core/index.mjs");
  const tok = async (name) => (await api("/api/v1/auth/register", { username: name, password: "benchpass1", invite })).token;
  const [ta, tb] = [await tok("media_a"), await tok("media_b")];
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const open = async (profile, token) => {
    const ctx = await browser.newContext();
    const cfg = { servers: [{ id: "s", address: ADDR, name: "B", username: profile, token }], settings: { notifications: false } };
    await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), [`nexustalk.config.${profile}`, JSON.stringify(cfg)]);
    const p = await ctx.newPage();
    await p.goto(`http://localhost:5173/?profile=${profile}`);
    await p.waitForSelector(".chan .name");
    return p;
  };
  const pa = await open("media_a", ta);
  const pb = await open("media_b", tb);
  // All processes of the Playwright Chromium (browser, renderers, GPU, utility).
  const pids = () =>
    execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process | Where-Object { $_.Path -like '*ms-playwright*' } | ForEach-Object { $_.Id }"])
      .toString()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  await sleep(3000);
  out.media.idle_two_clients = await cpuPercent(pids, 10);
  console.log("media idle (2 clients, text only)", out.media.idle_two_clients);
  for (const p of [pa, pb]) await p.locator(".chan", { hasText: "Allgemein" }).last().click();
  await sleep(6000);
  out.media.voice_call = await cpuPercent(pids, 15);
  console.log("voice call (2 clients, both directions)", out.media.voice_call);
  for (const [prof, label] of [["eco", "screen_720p_10fps"], ["balanced", "screen_1080p_30fps"]]) {
    await pa.evaluate((pr) => {
      const n = window.__nexus;
      n.updateSettings({ screenProfile: pr });
      return n.voice.value.startScreen();
    }, prof);
    await sleep(5000);
    out.media[label] = await cpuPercent(pids, 15);
    out.media[label].note = "fake capture device (synthetic video), headless Chromium, software encoding";
    console.log(label, out.media[label]);
    await pa.evaluate(() => window.__nexus.voice.value.stopScreen());
    await sleep(2000);
  }
  await browser.close();
} else {
  out.media.skipped = "UI dev server not running on :5173";
}

srv.kill();
const file = join(ROOT, "tests", "bench", "last-run.json");
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nwritten ${file}`);

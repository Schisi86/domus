// Starts a headless server with sample content for screenshots and design
// reviews, prints the owner token and keeps running until Ctrl+C.
//
//   node tests/e2e/seed.mjs [port]      (requires `cargo build -p nexus-server`)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.argv[2] || 7979);
const ADDR = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = mkdtempSync(join(tmpdir(), "nx-seed-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = false\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "nexustalk-server.exe" : "nexustalk-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });
const stop = () => {
  server.kill();
  setTimeout(() => rmSync(dataDir, { recursive: true, force: true }), 500);
};
process.on("SIGINT", () => (stop(), process.exit(0)));
process.on("SIGTERM", () => (stop(), process.exit(0)));

async function post(path, body, token) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return r.json();
}

/** Minimal WebSocket RPC client. */
function client(token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    let id = 1;
    const wait = new Map();
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      const w = wait.get(f.re);
      if (w) {
        wait.delete(f.re);
        f.ok ? w[0](f.d) : w[1](f.err);
      }
    };
    const rpc = (op, d) =>
      new Promise((ok, no) => {
        const i = ++id;
        wait.set(i, [ok, no]);
        ws.send(JSON.stringify({ id: i, op, d }));
      });
    ws.onopen = async () => {
      try {
        const ready = await rpc("auth", { token });
        res({ rpc, ready, close: () => ws.close() });
      } catch (e) {
        rej(e);
      }
    };
    ws.onerror = rej;
  });
}

for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${ADDR}/api/v1/info`)).ok) break;
  } catch {
    /* starting */
  }
  await sleep(250);
}
const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
const owner = await post("/api/v1/auth/register", { username: "christian", password: "testpass123", invite: setup });
const o = await client(owner.token);
await o.rpc("server.update", { name: "Cyber Crew", description: "Allgemeiner Austausch" });
const inv = await o.rpc("invite.create", { max_uses: null, expires_hours: 24 });
const lena = await post("/api/v1/auth/register", { username: "Lena", password: "testpass123", invite: inv.code });
const max = await post("/api/v1/auth/register", { username: "max", password: "testpass123", invite: inv.code });
const l = await client(lena.token);
const m = await client(max.token);
const channels = o.ready?.channels ?? [];
const general = channels.find((c) => c.kind === "text")?.id ?? 1;
const send = (c, content) => c.rpc("message.send", { channel_id: general, content });
await send(o, "🎉 Hallo **Welt**! Das ist *kursiv*, __unterstrichen__, ~~durch~~ und ||Spoiler||");
await send(l, "Hey zusammen! 👋 Wer ist heute Abend dabei?");
const msg = await send(m, "Ich bin dabei – **20 Uhr** in der Lounge?");
await send(o, "Klingt gut! Ich teile meinen Bildschirm, dann zeige ich euch das neue Design.");
await send(l, "Hier die Agenda:\n1. Patch-Notes\n2. Turnier-Planung\n3. ||Überraschung||");
await send(m, "✅ `npm run build` läuft übrigens wieder durch");
if (msg?.id) {
  await l.rpc("reaction.add", { message_id: msg.id, emoji: "👍" }).catch(() => {});
  await o.rpc("reaction.add", { message_id: msg.id, emoji: "👍" }).catch(() => {});
  await o.rpc("reaction.add", { message_id: msg.id, emoji: "🔥" }).catch(() => {});
}
await l.rpc("user.update", { status_text: "Coffee first" }).catch(() => {});
l.close();
m.close();
o.close();
console.log(`READY ${ADDR} ${owner.token}`);
setInterval(() => {}, 1 << 30);

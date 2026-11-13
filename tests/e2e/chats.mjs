// End-to-end test of the chat features of Domus 1.0.2 in the real web UI:
// pin, archive and "delete for me" for direct messages, the conversation
// filter, read receipts, quiet hours and a status message that expires.
//
// Usage: node tests/e2e/chats.mjs   (requires `cargo build -p nexus-server`
// and the UI dev server: npm --prefix app run dev)

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7997;
const ADDR = `http://127.0.0.1:${PORT}`;
const UI = "http://localhost:5173";
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};
async function waitFor(fn, timeout = 10000, step = 150) {
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

const dataDir = mkdtempSync(join(tmpdir(), "nx-chats-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = false\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "domus-server.exe" : "domus-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });

async function api(path, body) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}
/** A persistent WebSocket client for the other users. */
function client(token) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    let id = 1;
    const wait = new Map();
    const c = {
      ready: null,
      rpc: (op, d) =>
        new Promise((ok, no) => {
          const n = ++id;
          wait.set(n, [ok, no]);
          ws.send(JSON.stringify({ id: n, op, d }));
        }),
      close: () => ws.close(),
    };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.re === 1) return f.ok ? ((c.ready = f.d), res(c)) : rej(f.err);
      const w = wait.get(f.re);
      if (w) {
        wait.delete(f.re);
        f.ok ? w[0](f.d) : w[1](f.err);
      }
    };
    ws.onerror = rej;
  });
}

let browser;
try {
  if (!(await waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok))) throw new Error("server did not start");
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const alice = await api("/api/v1/auth/register", { username: "alice", password: "testpass123", invite: setup });
  const a = await client(alice.token);
  const inv = await a.rpc("invite.create", { max_uses: 10 });
  const others = [];
  for (const name of ["bob", "carla", "dana", "emil", "frieda"]) {
    const r = await api("/api/v1/auth/register", { username: name, password: "testpass123", invite: inv.code });
    const c = await client(r.token);
    const dm = await c.rpc("dm.open", { user_id: a.ready.me.id });
    await c.rpc("message.send", { channel_id: dm.channel_id, content: `Hallo von ${name}` });
    others.push({ name, c, cid: dm.channel_id });
  }
  const bob = others[0];

  browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const cfg = { servers: [{ id: "srv", address: ADDR, fingerprint: null, name: "E2E", username: "alice", token: alice.token }], settings: { uiSounds: false, notifications: false }, host_autostart: false, hosts_autostart: true, minimize_to_tray: true };
  await ctx.addInitScript(([k, v]) => {
    if (location.origin !== "http://localhost:5173") return;
    if (!sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem(k, v);
    }
  }, ["nexustalk.config.chats", JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror", e.message));
  await page.goto(`${UI}/?profile=chats`);
  await page.locator(".rail-btn.home").click();
  const row = (name) => page.locator(".sidebar .chan", { hasText: name });
  check("five conversations are listed", !!(await waitFor(async () => (await page.locator(".sidebar .chan .ellipsis").count()) >= 5)));

  // Filter
  await page.locator(".dm-filter").fill("dan");
  check("filter narrows the list", !!(await waitFor(async () => (await row("dana").count()) === 1 && (await row("bob").count()) === 0)));
  await page.locator(".dm-filter").fill("");

  // Pin
  await row("bob").click({ button: "right" });
  await page.locator(".menu button", { hasText: "Oben anheften" }).click();
  check("pinned chat moves to the top", !!(await waitFor(async () => (await page.locator(".sidebar .chan .ellipsis").nth(0).textContent()) === "bob")));
  check("pin mark is shown", (await row("bob").locator("svg title", { hasText: "Angeheftet" }).count()) === 1);

  // Archive
  await row("carla").click({ button: "right" });
  await page.locator(".menu button", { hasText: "Archivieren" }).click();
  check("archived chat leaves the list", !!(await waitFor(async () => (await row("carla").count()) === 0)));
  check("archive section shows the count", (await page.locator(".archive-head").textContent())?.includes("Archiv (1)"));
  await page.locator(".archive-head").click();
  check("archive opens on click", !!(await waitFor(async () => (await row("carla").count()) === 1)));
  const st = await a.rpc("dm.open", { user_id: others[1].c.ready.me.id });
  const c2 = await client(alice.token);
  check("archive is stored on the server", c2.ready.dms.find((d) => d.channel_id === st.channel_id)?.archived === true);
  c2.close();
  await row("carla").click({ button: "right" });
  await page.locator(".menu button", { hasText: "Aus dem Archiv holen" }).click();
  check("unarchive brings it back", !!(await waitFor(async () => (await page.locator(".archive-head").count()) === 0 && (await row("carla").count()) === 1)));

  // Read receipts
  await row("bob").click();
  await page.locator(".composer textarea").fill("Hast du das gelesen?");
  await page.locator(".composer textarea").press("Enter");
  check("own message shows 'Zugestellt'", !!(await waitFor(() => page.locator(".receipt", { hasText: "Zugestellt" }).count())));
  const hist = await bob.c.rpc("message.history", { channel_id: bob.cid });
  const last = hist.messages[hist.messages.length - 1];
  await bob.c.rpc("channel.ack", { channel_id: bob.cid, message_id: last.id });
  check("turns into 'Gelesen' when bob reads it", !!(await waitFor(() => page.locator(".receipt.seen", { hasText: "Gelesen" }).count())));

  // Delete for me (from the header menu)
  await page.locator(".main-head button[title='Weitere Optionen']").click();
  await page.locator(".menu button", { hasText: "Chat löschen" }).click();
  await page.locator(".modal button.danger", { hasText: "Für mich löschen" }).click();
  check("deleted chat disappears", !!(await waitFor(async () => (await row("bob").count()) === 0)));
  const bobHist = await bob.c.rpc("message.history", { channel_id: bob.cid });
  check("bob still has the messages", bobHist.messages.length === 2);
  await bob.c.rpc("message.send", { channel_id: bob.cid, content: "Bist du noch da?" });
  check("a new message brings the chat back", !!(await waitFor(async () => (await row("bob").count()) === 1)));
  await row("bob").click();
  await waitFor(() => page.locator(".msg-text", { hasText: "Bist du noch da?" }).count());
  const texts = await page.locator(".msg-text").allTextContents();
  check("only the new message is shown", texts.length === 1 && texts[0].includes("Bist du noch da?"), texts.join(" | "));

  // Quiet hours and status expiry
  await page.locator(".user-panel button[title='Einstellungen']").click();
  await page.getByRole("button", { name: "Benachrichtigungen" }).click();
  await page.locator("label.row", { hasText: "Ruhezeiten" }).locator(".toggle").click();
  const quiet = await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem("nexustalk.config.chats")).settings.quietHours?.on === true));
  check("quiet hours can be switched on", !!quiet);
  const inQuiet = await page.evaluate(async () => {
    const m = await import("/src/state/app.ts");
    m.updateSettings({ quietHours: { on: true, from: "00:00", to: "23:59" } });
    const a = m.inQuietHours(new Date(2026, 0, 1, 12, 0));
    m.updateSettings({ quietHours: { on: true, from: "22:00", to: "07:00" } });
    return [a, m.inQuietHours(new Date(2026, 0, 1, 23, 30)), m.inQuietHours(new Date(2026, 0, 1, 6, 59)), m.inQuietHours(new Date(2026, 0, 1, 12, 0))];
  });
  check("quiet hours also work across midnight", JSON.stringify(inQuiet) === "[true,true,true,false]", JSON.stringify(inQuiet));
  await page.getByRole("button", { name: "Mein Konto" }).click();
  await page.locator(".pane-content input.input").nth(1).fill("Im Meeting");
  await page.locator(".pane-content select.select").selectOption("30");
  await page.locator(".pane-content button.btn.primary", { hasText: "Speichern" }).first().click();
  const exp = await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem("nexustalk.config.chats")).settings.statusExpiry?.srv ?? 0));
  check("status gets an expiry about 30 minutes ahead", exp && Math.abs(exp - Date.now() - 30 * 60_000) < 120_000);
  await page.evaluate(async () => {
    const m = await import("/src/state/app.ts");
    m.updateSettings({ statusExpiry: { srv: Date.now() - 1000 } });
  });
  const cleared = await waitFor(async () => {
    const c = await client(alice.token);
    const s = c.ready.me.status_text;
    c.close();
    return s === "";
  }, 45000, 2000);
  check("expired status is cleared on the server", !!cleared);
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(400);
  rmSync(dataDir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), "chats-last-run.json"), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed, failed, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

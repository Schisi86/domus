// Interaction features in the real web UI with two users (owner + member):
// polls, forwarding, mark as unread, slow mode, timeout / kick through the
// user menu, soundboard, server mute and moving between voice channels.
//
// Usage: node tests/e2e/interact.mjs   (requires `cargo build -p nexus-server`
// and the UI dev server: npm --prefix app run dev)

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7992;
const UDP = 3492;
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

const dataDir = mkdtempSync(join(tmpdir(), "nx-interact-"));
writeFileSync(join(dataDir, "server.toml"), `port = ${PORT}\n[tls]\nenabled = false\n[media]\nstun_enabled = true\nudp_port = ${UDP}\n`);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "nexustalk-server.exe" : "nexustalk-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });

async function api(path, body) {
  const r = await fetch(ADDR + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
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
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  await ctx.grantPermissions(["microphone", "camera"], { origin: UI });
  const cfg = { servers: [{ id: "srv", address: ADDR, fingerprint: null, name: "E2E", username, token }], settings: { notifications: false, language: "de", showMembers: true }, host_autostart: false, minimize_to_tray: true };
  await ctx.addInitScript(([key, value]) => localStorage.setItem(key, value), [`nexustalk.config.${profile}`, JSON.stringify(cfg)]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${profile}] pageerror`, e.message));
  await page.goto(`${UI}/?profile=${profile}`);
  await page.waitForSelector(".chan .name", { timeout: 15000 });
  return page;
}
async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, name) });
}
/** Opens a path of (sub)menu entries, e.g. ["Moderation", "Auszeit", "5 Minuten"]. */
async function menuPath(page, labels) {
  for (let i = 0; i < labels.length; i++) {
    const item = page.locator(".menu button", { hasText: labels[i] }).last();
    await item.waitFor({ timeout: 4000 });
    if (i < labels.length - 1) await item.hover();
    else await item.click();
  }
}
function edgePath() {
  const c = [process.env.NEXUS_E2E_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"];
  return c.find((p) => p && existsSync(p));
}

let browser;
try {
  await waitFor(async () => (await fetch(`${ADDR}/api/v1/info`)).ok);
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const a = await api("/api/v1/auth/register", { username: "alice", password: "testpass123", invite: setup });
  const inv = await wsCall(a.token, "invite.create", { max_uses: 5 });
  const b = await api("/api/v1/auth/register", { username: "bob", password: "testpass123", invite: inv.code });
  const ready = await wsCall(a.token, "ping", {}).then(() => null);
  void ready;

  browser = await chromium.launch({
    ...(edgePath() ? { executablePath: edgePath() } : {}),
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
  });
  const pa = await openClient(browser, "alice", a.token, "alice");
  const pb = await openClient(browser, "bob", b.token, "bob");
  await pa.locator(".chan", { hasText: "allgemein" }).first().click();
  await pb.locator(".chan", { hasText: "allgemein" }).first().click();

  // ------------------------------------------------------------ poll
  await pa.locator(".composer-row .icon-btn[title='Hinzufügen']").click();
  await menuPath(pa, ["Umfrage erstellen"]);
  await pa.locator(".modal input.input").first().fill("Was essen wir heute?");
  await pa.locator(".modal input[placeholder='Antwort 1']").fill("Pizza");
  await pa.locator(".modal input[placeholder='Antwort 2']").fill("Sushi");
  await pa.locator(".modal input[placeholder='Antwort 3']").fill("Burger");
  await shot(pa, "poll-dialog.png");
  await pa.locator(".modal .btn.primary", { hasText: "Umfrage posten" }).click();
  const seen = await waitFor(() => pb.locator(".poll .poll-q", { hasText: "Was essen wir heute?" }).count());
  check("poll: member sees the new poll", !!seen);
  await pb.locator(".poll-opt", { hasText: "Pizza" }).click();
  const picked = await waitFor(() => pb.locator(".poll-opt.picked", { hasText: "Pizza" }).count());
  check("poll: member's vote is marked", !!picked);
  const counted = await waitFor(async () => ((await pa.locator(".poll-opt", { hasText: "Pizza" }).locator(".poll-count").textContent()) ?? "").startsWith("1 ·"));
  check("poll: owner sees the vote live", !!counted);
  await shot(pb, "poll.png");

  // ------------------------------------------------------------ forwarding
  const general = (await wsCall(a.token, "message.history", { channel_id: 1, limit: 1 }).catch(() => null)) && null;
  void general;
  await wsCall(a.token, "channel.create", { kind: "text", name: "zweiter" });
  await wsCall(b.token, "message.send", { channel_id: await pb.evaluate(() => window.__nexus.servers.value[0].channels.value.find((c) => c.name === "allgemein").id), content: "Bitte weiterleiten 📎" });
  const msg = pa.locator(".msg", { hasText: "Bitte weiterleiten" }).last();
  await msg.waitFor();
  await msg.hover();
  await msg.locator(".msg-actions .icon-btn[title='Weiterleiten']").click();
  await pa.locator(".modal .list-item", { hasText: "zweiter" }).locator("button").click();
  await pa.locator(".chan", { hasText: "zweiter" }).first().click();
  const fwd = await waitFor(async () => (await pa.locator(".msg-forwarded").first().textContent())?.includes("bob"));
  check("forward: copy appears with the original author", !!fwd);
  await pa.locator(".chan", { hasText: "allgemein" }).first().click();

  // ------------------------------------------------------------ mark as unread
  const first = pb.locator(".msg", { hasText: "Was essen wir heute?" }).last();
  await first.click({ button: "right" });
  await menuPath(pb, ["Als ungelesen markieren"]);
  const sep = await waitFor(() => pb.locator(".unread-sep").count());
  check("mark unread: 'new' marker appears", !!sep);

  // ------------------------------------------------------------ voice message
  await pb.locator(".composer-row .icon-btn[title='Sprachnachricht aufnehmen']").click();
  await pb.locator(".rec-bar").waitFor();
  await sleep(1800);
  await shot(pb, "voice-record.png");
  await pb.locator(".rec-bar .btn.primary").click();
  const vm = await waitFor(() => pa.locator(".audio-msg .wave i").count(), 20000);
  check("voice message: arrives with a waveform player", vm > 10, `${vm} bars`);
  const playable = await waitFor(async () => !(await pa.locator(".audio-msg .audio-play").last().isDisabled()));
  const dur = await waitFor(async () => {
    const t = (await pa.locator(".audio-msg .audio-time").last().textContent()) ?? "";
    return t !== "0:00" && t ? t : null;
  });
  check("voice message: playable with duration", !!playable && !!dur, dur ?? "");
  await shot(pa, "voice-message.png");

  // ------------------------------------------------------------ profile, inbox, save for later
  await wsCall(b.token, "user.update", { bio: "Strategie-Fan 🎲", banner: "#ff2a6d,#fcee0a" });
  await pa.locator(".members .member", { hasText: "bob" }).click();
  const prof = await waitFor(async () => (await pa.locator(".modal .profile-bio").textContent())?.includes("Strategie-Fan"));
  const bannerBg = await pa.locator(".modal .profile-banner").evaluate((el) => getComputedStyle(el).backgroundImage);
  check("profile: banner gradient and bio shown", !!prof && bannerBg.includes("gradient"), bannerBg.slice(0, 60));
  await shot(pa, "profile.png");
  await pa.keyboard.press("Escape");
  await wsCall(a.token, "message.send", { channel_id: await pa.evaluate(() => window.__nexus.servers.value[0].channels.value.find((c) => c.name === "allgemein").id), content: "@bob kannst du später drüberschauen?" });
  await pb.locator(".main-head .icon-btn[title='Posteingang']").click();
  const mention = await waitFor(() => pb.locator(".inbox .list-item", { hasText: "später drüberschauen" }).count());
  check("inbox: mention listed", !!mention);
  const target = pb.locator(".msg", { hasText: "später drüberschauen" }).last();
  await target.click({ button: "right" });
  await menuPath(pb, ["Für später speichern", "In 1 Stunde erinnern"]);
  await pb.locator(".inbox .tabs button", { hasText: "Für später" }).click();
  const saved = await waitFor(() => pb.locator(".inbox .list-item .reminder-chip").count());
  check("save for later: listed with reminder", !!saved);
  await shot(pb, "inbox.png");
  await pb.locator(".main-head .icon-btn[title='Posteingang']").click();

  // ------------------------------------------------------------ user menu: timeout
  await pa.locator(".members .member", { hasText: "bob" }).click({ button: "right" });
  await pa.locator(".menu button", { hasText: "Moderation" }).hover();
  await pa.locator(".menu button", { hasText: "Auszeit" }).last().hover();
  await shot(pa, "user-menu.png");
  await menuPath(pa, ["5 Minuten"]);
  const blocked = await waitFor(async () => (await pb.locator(".composer textarea").getAttribute("placeholder"))?.includes("Auszeit") && (await pb.locator(".composer textarea").isDisabled()));
  check("timeout: member's composer is blocked", !!blocked);
  const mark = await waitFor(() => pa.locator(".members .member", { hasText: "bob" }).locator(".timeout-mark").count());
  check("timeout: clock mark in the member list", !!mark);
  await pa.locator(".members .member", { hasText: "bob" }).click({ button: "right" });
  await menuPath(pa, ["Moderation", "Auszeit (läuft)", "Auszeit aufheben"]);
  const free = await waitFor(async () => !(await pb.locator(".composer textarea").isDisabled()));
  check("timeout: lifted again", !!free);

  // ------------------------------------------------------------ slow mode
  const gid = await pa.evaluate(() => window.__nexus.servers.value[0].channels.value.find((c) => c.name === "allgemein").id);
  await wsCall(a.token, "channel.update", { channel_id: gid, slowmode: 30 });
  const hint = await waitFor(() => pb.locator(".slowmode-hint").count());
  check("slow mode: hint shown to members", !!hint);
  await pb.locator(".composer textarea").fill("erste Nachricht");
  await pb.keyboard.press("Enter");
  const wait = await waitFor(async () => (await pb.locator(".composer textarea").getAttribute("placeholder"))?.includes("noch"));
  check("slow mode: countdown after sending", !!wait);
  await wsCall(a.token, "channel.update", { channel_id: gid, slowmode: 0 });

  // ------------------------------------------------------------ voice: soundboard, server mute, move
  const joinVoice = (p) => p.locator(".chan", { hasText: "Allgemein" }).filter({ has: p.locator("svg") }).last().click();
  await joinVoice(pa);
  await waitFor(() => pa.evaluate(() => window.__nexus.voice.value?.state.value === "connected"));
  await joinVoice(pb);
  await waitFor(() => pb.evaluate(() => window.__nexus.voice.value?.state.value === "connected"));
  await pb.locator(".voice-panel .btn[title='Soundboard']").click();
  await shot(pb, "soundboard.png");
  await pb.locator(".sb-btn", { hasText: "Airhorn" }).click();
  const cooling = await waitFor(() => pb.locator(".sb-btn[disabled]").count());
  const errToast = await pb.locator(".toast", { hasText: "Sound" }).count();
  check("soundboard: sound sent (cooldown starts, no error)", !!cooling && !errToast);
  await pb.keyboard.press("Escape");

  // ------------------------------------------------------------ call reactions, raised hand, input gate
  const gated = await pb.evaluate(() => !!window.__nexus.voice.value.gate);
  check("input sensitivity: mic runs through the gate", gated);
  await pa.locator(".chan", { hasText: "Allgemein" }).filter({ has: pa.locator("svg") }).last().click();
  await pb.locator(".chan", { hasText: "Allgemein" }).filter({ has: pb.locator("svg") }).last().click();
  await pb.locator(".voice-controls .round-btn[title='Reagieren']").click();
  await pb.locator(".call-reactions button", { hasText: "🎉" }).click();
  const floated = await waitFor(() => pa.locator(".tile .float-emoji", { hasText: "🎉" }).count(), 5000, 100);
  check("call reactions: emoji floats over the tile for others", !!floated);
  await pb.keyboard.press("Escape");
  await pb.locator(".voice-controls .round-btn[title='Hand heben']").click();
  const hand = await waitFor(() => pa.locator(".tile .hand-badge").count());
  const sideHand = await pa.locator(".voice-user", { hasText: "bob" }).textContent();
  check("raise hand: badge on the tile and in the channel list", !!hand && (sideHand ?? "").includes("✋"));
  await shot(pa, "call.png");
  await pb.locator(".voice-controls .round-btn[title='Hand senken']").click();

  const voiceUser = pa.locator(".voice-user", { hasText: "bob" });
  await voiceUser.waitFor();
  await voiceUser.click({ button: "right" });
  await menuPath(pa, ["Sprachkanal", "Serverseitig stummschalten"]);
  const muted = await waitFor(() => pb.evaluate(() => window.__nexus.voice.value?.serverMuted.value === true));
  const notice = await waitFor(() => pb.locator(".voice-panel .notice", { hasText: "stummgeschaltet" }).count());
  const trackOff = await pb.evaluate(() => !window.__nexus.voice.value.transmitting());
  check("server mute: member is muted and told why", !!muted && !!notice && trackOff);
  await pb.evaluate(() => window.__nexus.voice.value.setMuted(false));
  const stillMuted = await pb.evaluate(() => window.__nexus.voice.value.serverMuted.value && !window.__nexus.voice.value.transmitting());
  check("server mute: member cannot unmute", stillMuted);
  await voiceUser.click({ button: "right" });
  await menuPath(pa, ["Sprachkanal", "Serverseitig stummschalten"]);
  const unmuted = await waitFor(() => pb.evaluate(() => window.__nexus.voice.value?.serverMuted.value === false));
  check("server mute: lifted by the moderator", !!unmuted);

  const lounge = await wsCall(a.token, "channel.create", { kind: "voice", name: "Lounge" });
  await waitFor(() => pa.locator(".chan", { hasText: "Lounge" }).count());
  await voiceUser.click({ button: "right" });
  await menuPath(pa, ["Sprachkanal", "Verschieben nach", "Lounge"]);
  const moved = await waitFor(() => pb.evaluate((id) => window.__nexus.voice.value?.channelId === id && window.__nexus.voice.value.state.value === "connected", lounge.id));
  check("move: member lands in the other voice channel", !!moved);

  // ------------------------------------------------------------ kick
  await pa.locator(".chan", { hasText: "allgemein" }).first().click();
  await pa.locator(".members .member", { hasText: "bob" }).click({ button: "right" });
  await menuPath(pa, ["Moderation", "Kicken"]);
  await pa.locator(".modal .btn.danger", { hasText: "Kicken" }).click();
  const out = await waitFor(() => pb.locator(".conn-banner.err").count(), 15000);
  check("kick: member is signed out", !!out);
  const pending = await wsCall(a.token, "member.list_status", { status: "pending" });
  check("kick: account waits for approval", pending.some((u) => u.username === "bob"));
} catch (e) {
  check("run", false, String(e?.stack ?? e));
} finally {
  await browser?.close();
  server.kill();
  await sleep(500);
  rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  writeFileSync(join(ROOT, "tests", "e2e", "interact-last-run.json"), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

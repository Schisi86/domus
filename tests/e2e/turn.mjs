// Voice relay over TCP: a headless server with TURN enabled, two Chromium
// peer connections that may only use relayed candidates over TCP (the path
// friends take through the desktop app's internet tunnel). Checks that audio
// and a data channel flow and that the selected path really is TURN/TCP.
//
//   cargo build -p nexus-server && node tests/e2e/turn.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 7991;
const UDP = 3591;
const ADDR = `http://127.0.0.1:${PORT}`;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  – " + detail : ""}`);
};

const dataDir = mkdtempSync(join(tmpdir(), "nx-turn-"));
writeFileSync(
  join(dataDir, "server.toml"),
  `port = ${PORT}\n[tls]\nenabled = false\n[media]\nturn_enabled = true\nudp_port = ${UDP}\nrelay_ip = "127.0.0.1"\nrelay_port_min = 49700\nrelay_port_max = 49750\n`,
);
const exe = join(ROOT, "target", "debug", process.platform === "win32" ? "nexustalk-server.exe" : "nexustalk-server");
const server = spawn(exe, ["--data", dataDir], { stdio: "ignore" });
let browser;

try {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${ADDR}/api/v1/info`)).ok) break;
    } catch {
      /* starting */
    }
    await sleep(250);
  }
  const setup = readFileSync(join(dataDir, "setup-code.txt"), "utf8").trim();
  const owner = await (
    await fetch(`${ADDR}/api/v1/auth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "turnowner", password: "testpass123", invite: setup }) })
  ).json();
  const ready = await new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/v1/ws`);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, op: "auth", d: { token: owner.token } }));
    ws.onmessage = (ev) => {
      const f = JSON.parse(ev.data);
      if (f.re === 1) {
        ws.close();
        f.ok ? res(f.d) : rej(f.err);
      }
    };
    ws.onerror = rej;
  });
  const turn = ready.ice?.turn;
  check("server hands out TURN credentials with TCP", !!turn?.username && turn.tcp === true, JSON.stringify({ port: turn?.port, tcp: turn?.tcp }));

  browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  const page = await browser.newPage();
  await page.goto("about:blank");
  const r = await page.evaluate(
    async ({ port, username, credential }) => {
      const cfg = { iceServers: [{ urls: `turn:127.0.0.1:${port}?transport=tcp`, username, credential }], iceTransportPolicy: "relay" };
      const a = new RTCPeerConnection(cfg);
      const b = new RTCPeerConnection(cfg);
      a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
      b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
      // Audio: a test tone from A to B.
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const dest = ctx.createMediaStreamDestination();
      osc.connect(dest);
      osc.start();
      for (const t of dest.stream.getAudioTracks()) a.addTrack(t, dest.stream);
      const gotTrack = new Promise((res) => (b.ontrack = (e) => res(e.track.kind)));
      const dc = a.createDataChannel("probe");
      const gotMsg = new Promise((res) => (b.ondatachannel = (e) => (e.channel.onmessage = (m) => res(m.data))));
      dc.onopen = () => dc.send("hallo über TURN/TCP");
      await a.setLocalDescription();
      await b.setRemoteDescription(a.localDescription);
      await b.setLocalDescription();
      await a.setRemoteDescription(b.localDescription);
      const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms));
      const msg = await Promise.race([gotMsg, timeout(15000)]).catch((e) => String(e));
      const track = await Promise.race([gotTrack, timeout(5000)]).catch((e) => String(e));
      await new Promise((r) => setTimeout(r, 2500));
      let pair = null;
      let audioBytes = 0;
      const stats = await b.getStats();
      const sa = await a.getStats();
      sa.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) {
          const p = sa.get(s.selectedCandidatePairId);
          const l = sa.get(p.localCandidateId);
          pair = { type: l?.candidateType, relayProtocol: l?.relayProtocol, state: p.state };
        }
      });
      stats.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "audio") audioBytes = s.bytesReceived;
      });
      a.close();
      b.close();
      return { msg, track, pair, audioBytes };
    },
    { port: turn.port, username: turn.username, credential: turn.credential },
  );
  check("data channel opens through the relay", r.msg === "hallo über TURN/TCP", r.msg);
  check("audio track arrives", r.track === "audio", r.track);
  check("audio packets flow", r.audioBytes > 5000, `${r.audioBytes} bytes`);
  check("selected path is TURN over TCP", r.pair?.type === "relay" && r.pair?.relayProtocol === "tcp", JSON.stringify(r.pair));
} catch (e) {
  check("test run", false, String(e?.stack ?? e));
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await sleep(500);
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

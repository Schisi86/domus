// Remote control UI. The host allows control of the shared whole screen –
// protected by an optional password, otherwise every request is confirmed by
// hand. A viewer then drives mouse and keyboard (or a controller) over the
// call's data channel; one key (F8 by default) switches between the own
// computer and the remote one. Input is injected by the desktop app's backend.

import { effect } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { voice, type VoiceSession } from "../rtc/voice";
import { t } from "../i18n";
import { settings, showMenu, toast } from "../state/app";
import { isTauri } from "../platform";
import { Avatar, Icon, IconButton, Popover, Toggle, promptDialog } from "./components";

/**
 * Browser `KeyboardEvent.code` → hardware scan code (set 1) and whether it is
 * an "extended" key. Sending physical keys means the remote computer applies
 * its own keyboard layout, exactly as if the key was pressed there.
 */
const SC: Record<string, [number, boolean]> = {
  Escape: [0x01, false], Digit1: [0x02, false], Digit2: [0x03, false], Digit3: [0x04, false], Digit4: [0x05, false], Digit5: [0x06, false],
  Digit6: [0x07, false], Digit7: [0x08, false], Digit8: [0x09, false], Digit9: [0x0a, false], Digit0: [0x0b, false], Minus: [0x0c, false],
  Equal: [0x0d, false], Backspace: [0x0e, false], Tab: [0x0f, false], KeyQ: [0x10, false], KeyW: [0x11, false], KeyE: [0x12, false],
  KeyR: [0x13, false], KeyT: [0x14, false], KeyY: [0x15, false], KeyU: [0x16, false], KeyI: [0x17, false], KeyO: [0x18, false],
  KeyP: [0x19, false], BracketLeft: [0x1a, false], BracketRight: [0x1b, false], Enter: [0x1c, false], ControlLeft: [0x1d, false],
  KeyA: [0x1e, false], KeyS: [0x1f, false], KeyD: [0x20, false], KeyF: [0x21, false], KeyG: [0x22, false], KeyH: [0x23, false],
  KeyJ: [0x24, false], KeyK: [0x25, false], KeyL: [0x26, false], Semicolon: [0x27, false], Quote: [0x28, false], Backquote: [0x29, false],
  ShiftLeft: [0x2a, false], Backslash: [0x2b, false], KeyZ: [0x2c, false], KeyX: [0x2d, false], KeyC: [0x2e, false], KeyV: [0x2f, false],
  KeyB: [0x30, false], KeyN: [0x31, false], KeyM: [0x32, false], Comma: [0x33, false], Period: [0x34, false], Slash: [0x35, false],
  ShiftRight: [0x36, false], NumpadMultiply: [0x37, false], AltLeft: [0x38, false], Space: [0x39, false], CapsLock: [0x3a, false],
  F1: [0x3b, false], F2: [0x3c, false], F3: [0x3d, false], F4: [0x3e, false], F5: [0x3f, false], F6: [0x40, false], F7: [0x41, false],
  F8: [0x42, false], F9: [0x43, false], F10: [0x44, false], NumLock: [0x45, true], ScrollLock: [0x46, false], Numpad7: [0x47, false],
  Numpad8: [0x48, false], Numpad9: [0x49, false], NumpadSubtract: [0x4a, false], Numpad4: [0x4b, false], Numpad5: [0x4c, false],
  Numpad6: [0x4d, false], NumpadAdd: [0x4e, false], Numpad1: [0x4f, false], Numpad2: [0x50, false], Numpad3: [0x51, false],
  Numpad0: [0x52, false], NumpadDecimal: [0x53, false], IntlBackslash: [0x56, false], F11: [0x57, false], F12: [0x58, false],
  NumpadEnter: [0x1c, true], ControlRight: [0x1d, true], NumpadDivide: [0x35, true], PrintScreen: [0x37, true], AltRight: [0x38, true],
  Home: [0x47, true], ArrowUp: [0x48, true], PageUp: [0x49, true], ArrowLeft: [0x4b, true], ArrowRight: [0x4d, true], End: [0x4f, true],
  ArrowDown: [0x50, true], PageDown: [0x51, true], Insert: [0x52, true], Delete: [0x53, true], MetaLeft: [0x5b, true], MetaRight: [0x5c, true],
  ContextMenu: [0x5d, true],
};

type KeyCmd = { t: "k"; s: number; e: boolean; d: boolean };
const keyCmd = (code: string, d: boolean): KeyCmd | null => (SC[code] ? { t: "k", s: SC[code][0], e: SC[code][1], d } : null);

/** A key combination pressed and released on the remote computer. */
function chord(codes: string[]): KeyCmd[] {
  const down = codes.map((c) => keyCmd(c, true)).filter((x): x is KeyCmd => !!x);
  const up = [...codes].reverse().map((c) => keyCmd(c, false)).filter((x): x is KeyCmd => !!x);
  return [...down, ...up];
}

/** Combinations the local system would swallow; sent from a small menu instead. */
const SPECIAL: { label: () => string; keys: string[] }[] = [
  { label: () => "Win", keys: ["MetaLeft"] },
  { label: () => "Alt + Tab", keys: ["AltLeft", "Tab"] },
  { label: () => "Win + D", keys: ["MetaLeft", "KeyD"] },
  { label: () => t("rc2.kTask"), keys: ["ControlLeft", "ShiftLeft", "Escape"] },
  { label: () => "Alt + F4", keys: ["AltLeft", "F4"] },
  { label: () => t("rc2.kPrint"), keys: ["PrintScreen"] },
];

export const REMOTE_KEYS = ["F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12"];

// ------------------------------------------------------------- host

/** Host: allow remote control of the shared whole screen, optionally with a password. */
export function ControlHostButton({ v }: { v: VoiceSession }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [reveal, setReveal] = useState(false);
  const on = v.remoteAllowed.value;
  const sharing = v.sharingScreen.value;
  const monitor = v.screenIsMonitor.value;
  const ready = sharing && monitor;
  const usePw = v.remoteUsePassword.value;
  const pw = v.remotePassword.value;
  const by = v.controlledBy.value;
  const title = !sharing ? t("rc2.needShare") : !monitor ? t("rc2.needFullScreen") : on ? t("rc2.allowed") : t("rc2.allow");
  return (
    <>
      <button
        class={`round-btn${on ? " on" : ""}${by !== null ? " live" : ""}`}
        title={title}
        aria-label={title}
        disabled={!ready}
        onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Icon.Remote />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div class="rc-menu">
            <h4><Icon.Remote size={17} /> {t("rc2.title")}</h4>
            <div class="faint xs">{t("rc2.menuHint")}</div>
            {!isTauri && <div class="notice warn xs">{t("rc2.desktopOnly")}</div>}
            {!monitor && <div class="notice warn xs">{t("rc2.needFullScreen")}</div>}
            <Toggle checked={on} disabled={!ready} onChange={(x) => v.setRemote(x)} label={t("rc2.turnOn")} />
            <Toggle
              checked={usePw}
              onChange={(x) => v.setRemote(on, { usePassword: x })}
              label={t("rc2.usePassword")}
              desc={usePw ? (pw ? t("rc2.pwOnDesc") : t("rc2.pwMissing")) : t("rc2.pwOffDesc")}
            />
            {usePw && (
              <label class="rc-field">
                <span class="label">{t("rc2.password")}</span>
                <span class="pw-wrap">
                  <input
                    class={`input${reveal ? "" : " masked"}`}
                    type="text"
                    autocomplete="off"
                    spellcheck={false}
                    value={pw}
                    placeholder={t("rc2.passwordPh")}
                    onInput={(e) => v.setRemote(on, { password: (e.target as HTMLInputElement).value })}
                  />
                  <button type="button" class="pw-eye" title={reveal ? t("rc2.hidePw") : t("rc2.showPw")} aria-label={reveal ? t("rc2.hidePw") : t("rc2.showPw")} onClick={() => setReveal(!reveal)}>
                    {reveal ? <Icon.EyeOff size={15} /> : <Icon.Eye size={15} />}
                  </button>
                </span>
              </label>
            )}
            {by !== null && (
              <div class="rc-active">
                <span class="live-dot" />
                <span class="grow">{t("rc2.controlledBy", { name: v.server.memberName(by) })}</span>
                <button class="btn sm danger" onClick={() => v.revokeControl()}>{t("rc2.stop")}</button>
              </div>
            )}
            <div class="faint xs">{t("rc2.panicHint", { key: settings.value.remoteKey })}</div>
          </div>
        </Popover>
      )}
    </>
  );
}

/** Banner on my own screen while someone controls my computer. */
export function ControlBanner({ v }: { v: VoiceSession }) {
  const by = v.controlledBy.value;
  if (by === null) return null;
  return (
    <div class="notice danger rc-banner">
      <span class="live-dot" />
      <span class="grow">{t("rc2.controlledBy", { name: v.server.memberName(by) })} · {t("rc2.panicHint", { key: settings.value.remoteKey })}</span>
      <button class="btn sm" onClick={() => v.revokeControl()}>{t("rc2.stop")}</button>
    </div>
  );
}

/** Host: somebody asks for control and no password is set – decide here. Shown app-wide. */
export function ControlRequestPrompt() {
  const v = voice.value;
  const req = v?.remoteRequest.value;
  const [left, setLeft] = useState(30);
  useEffect(() => {
    if (!req) return;
    const tick = () => setLeft(Math.max(0, 30 - Math.round((Date.now() - req.at) / 1000)));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [req?.at]);
  if (!v || !req) return null;
  const name = v.server.memberName(req.uid);
  return (
    <div class="rc-request" role="alertdialog" aria-label={t("rc2.askTitle")}>
      <Avatar server={v.server} userId={req.uid} name={name} size={38} />
      <div class="grow">
        <b>{t("rc2.askTitle")}</b>
        <div class="muted small">{t("rc2.askBody", { name })}</div>
      </div>
      <button class="btn sm" onClick={() => v.answerRemoteRequest(false)}>{t("rc2.askDeny")}</button>
      <button class="btn sm primary" onClick={() => v.answerRemoteRequest(true)}>{t("rc2.askAllow")} ({left})</button>
    </div>
  );
}

// ------------------------------------------------------------- viewer

/** Viewer: ask `uid` for control (with the password, if they set one). */
export async function takeControl(v: VoiceSession, uid: number) {
  const offer = v.remoteOffers.value.get(uid);
  if (!offer) return toast(t("rc2.notOffered", { name: v.server.memberName(uid) }), undefined, "warn");
  const name = v.server.memberName(uid);
  if (offer.pw) {
    const pw = await promptDialog({ title: t("rc2.joinTitle", { name }), label: t("rc2.password"), body: t("rc2.joinHint"), confirm: t("rc2.request"), password: true });
    if (pw === null) return;
    v.requestControl(uid, pw);
  } else {
    v.requestControl(uid);
    toast(t("rc2.waiting", { name }), t("rc2.waitingHint"), "info", 6000);
  }
}

let lastToggle = 0;
/** The switch key was pressed (system-wide hotkey or in the window). */
function switchKey(v: VoiceSession) {
  const now = performance.now();
  if (now - lastToggle < 200) return;
  lastToggle = now;
  v.toggleControl();
}

/** Position inside the stream picture (0..1), ignoring the letterbox bars. */
function norm(video: HTMLVideoElement | null, clientX: number, clientY: number, clamp = false) {
  if (!video) return null;
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth || r.width;
  const vh = video.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  let x = (clientX - (r.left + (r.width - dw) / 2)) / dw;
  let y = (clientY - (r.top + (r.height - dh) / 2)) / dh;
  if (clamp) {
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
  } else if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Viewer: the control bar on the remote screen and – while control is active –
 * a surface that captures mouse, keyboard and controller input for it.
 */
export function ControlSurface({ v, uid }: { v: VoiceSession; uid: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const active = v.controlActive.value;
  const [game, setGame] = useState(false);
  const [full, setFull] = useState(false);
  const key = settings.value.remoteKey;
  const held = useRef(new Set<string>());
  const buttons = useRef(new Set<number>());
  const name = v.server.memberName(uid);
  const video = () => (ref.current?.closest(".tile")?.querySelector("video") as HTMLVideoElement | null) ?? null;

  // Everything still pressed is released when control pauses or ends.
  const releaseAll = () => {
    const cmds: unknown[] = [];
    for (const code of held.current) {
      const c = keyCmd(code, false);
      if (c) cmds.push(c);
    }
    for (const b of buttons.current) cmds.push({ t: "b", b, d: false });
    held.current.clear();
    buttons.current.clear();
    if (cmds.length) v.sendInput(cmds);
  };

  // Keyboard. The listeners live as long as the control session and look at the
  // live state, so switching with the key takes effect on the very next key.
  useEffect(() => {
    const on = () => v.controlActive.peek() && v.controlling.peek() !== null;
    const down = (e: KeyboardEvent) => {
      if (e.code === key) {
        // The switch key itself (the desktop app also registers it system-wide).
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) switchKey(v);
        return;
      }
      if (!on()) return;
      e.preventDefault();
      e.stopPropagation();
      const c = keyCmd(e.code, true);
      if (!c) return;
      held.current.add(e.code);
      v.sendInput([c]);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === key || !held.current.has(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      held.current.delete(e.code);
      const c = keyCmd(e.code, false);
      if (c) v.sendInput([c]);
    };
    // Leaving the window pauses control – nothing gets stuck or lands in the wrong place.
    const blur = () => on() && v.toggleControl(false);
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", blur);
    const kb = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
    // Runs at once whenever control is switched on or off.
    const stop = effect(() => {
      if (v.controlActive.value) {
        (document.activeElement as HTMLElement | null)?.blur?.();
        // In full screen even Alt+Tab, the Windows key and Esc reach the remote side.
        void kb?.lock?.().catch(() => {});
      } else {
        kb?.unlock?.();
        releaseAll();
        if (document.pointerLockElement) document.exitPointerLock();
      }
    });
    return () => {
      stop();
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", blur);
      kb?.unlock?.();
      releaseAll();
    };
  }, [key]);

  // Mouse wheel (needs a non-passive listener) and game mode (relative movement).
  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    let wheelAcc = 0;
    let wheelAccX = 0;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 1 / 3 : 1 / 100;
      wheelAcc -= e.deltaY * unit;
      wheelAccX += e.deltaX * unit;
      const dy = Math.trunc(wheelAcc * 4) / 4;
      const dx = Math.trunc(wheelAccX * 4) / 4;
      if (dy || dx) {
        wheelAcc -= dy;
        wheelAccX -= dx;
        v.sendInput([{ t: "w", dy, dx }]);
      }
    };
    let accX = 0;
    let accY = 0;
    let frame = 0;
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== el) return;
      accX += e.movementX;
      accY += e.movementY;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (accX || accY) v.sendInput([{ t: "r", dx: accX, dy: accY }]);
          accX = accY = 0;
        });
    };
    const lock = () => setGame(document.pointerLockElement === el);
    el.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("mousemove", move);
    document.addEventListener("pointerlockchange", lock);
    return () => {
      el.removeEventListener("wheel", wheel);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("pointerlockchange", lock);
      cancelAnimationFrame(frame);
      setGame(false);
    };
  }, [active]);

  // Controller: left stick moves the cursor, right stick scrolls, buttons click / press keys.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let cx = 0.5;
    let cy = 0.5;
    const prev: boolean[] = [];
    const map: Record<number, { b: number } | { code: string }> = {
      0: { b: 0 }, 1: { b: 2 }, 2: { code: "Space" }, 3: { code: "Enter" }, 9: { code: "Escape" },
      12: { code: "ArrowUp" }, 13: { code: "ArrowDown" }, 14: { code: "ArrowLeft" }, 15: { code: "ArrowRight" },
    };
    const loop = () => {
      const gp = navigator.getGamepads?.().find((g) => g);
      if (gp) {
        const dead = (n: number) => (Math.abs(n) > 0.18 ? n : 0);
        const ax = dead(gp.axes[0] ?? 0);
        const ay = dead(gp.axes[1] ?? 0);
        if (ax || ay) {
          cx = Math.max(0, Math.min(1, cx + ax * 0.012));
          cy = Math.max(0, Math.min(1, cy + ay * 0.02));
          v.sendMove(cx, cy);
        }
        const wy = dead(gp.axes[3] ?? 0);
        if (wy) v.sendInput([{ t: "w", dy: -wy * 0.35 }]);
        gp.buttons.forEach((b, i) => {
          const m = map[i];
          if (!m || b.pressed === (prev[i] ?? false)) return;
          prev[i] = b.pressed;
          if ("b" in m) v.sendInput([{ t: "b", b: m.b, d: b.pressed }]);
          else {
            const c = keyCmd(m.code, b.pressed);
            if (c) v.sendInput([c]);
          }
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", f);
    return () => document.removeEventListener("fullscreenchange", f);
  }, []);

  const btn = (e: PointerEvent) => (e.button === 1 ? 1 : e.button === 2 ? 2 : 0);
  const toggleGame = () => {
    const el = ref.current;
    if (!el) return;
    if (document.pointerLockElement === el) return document.exitPointerLock();
    const req = el.requestPointerLock as (o?: { unadjustedMovement?: boolean }) => Promise<void> | void;
    // Raw movement without pointer acceleration where the system supports it.
    Promise.resolve(req.call(el, { unadjustedMovement: true })).catch(() => void el.requestPointerLock());
  };
  const toggleFull = () => {
    const tile = ref.current?.closest(".tile") as HTMLElement | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void tile?.requestFullscreen?.().catch(() => {});
  };

  return (
    <>
      {active && (
        <div
          ref={ref}
          class={`rc-surface${game ? " game" : ""}`}
          data-uid={uid}
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            const b = btn(e);
            buttons.current.add(b);
            const n = game ? null : norm(video(), e.clientX, e.clientY, true);
            v.sendInput(n ? [{ t: "m", x: n.x, y: n.y }, { t: "b", b, d: true }] : [{ t: "b", b, d: true }]);
          }}
          onPointerUp={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const b = btn(e);
            buttons.current.delete(b);
            v.sendInput([{ t: "b", b, d: false }]);
          }}
          onPointerMove={(e) => {
            if (game) return;
            // While a button is held (dragging) the position is clamped to the picture.
            const n = norm(video(), e.clientX, e.clientY, buttons.current.size > 0);
            if (n) v.sendMove(n.x, n.y);
          }}
          onClick={(e) => e.stopPropagation()}
          onDblClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      )}
      <div class={`rc-hud${active ? " active" : ""}`} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <span class="live-dot" />
        <span class="rc-hud-text">{active ? t("rc2.hudActive", { name }) : t("rc2.hudPaused", { name })}</span>
        <button class="rc-key" title={active ? t("rc2.toMine") : t("rc2.toRemote")} onClick={() => v.toggleControl()}>
          <kbd>{key}</kbd>
          {active ? t("rc2.toMine") : t("rc2.toRemote")}
        </button>
        <span class="rc-hud-sep" />
        {active && (
          <IconButton title={game ? t("rc2.gameOff") : t("rc2.gameOn")} class="sm" active={game} onClick={toggleGame}>
            <Icon.Gamepad />
          </IconButton>
        )}
        <IconButton
          title={t("rc2.sendKeys")}
          class="sm"
          onClick={(e) =>
            showMenu(
              e as unknown as MouseEvent,
              SPECIAL.map((s) => ({ label: s.label(), onClick: () => v.sendInput(chord(s.keys)) })),
            )
          }
        >
          <Icon.Keyboard />
        </IconButton>
        <IconButton title={full ? t("voice.shrink") : t("voice.fullscreen")} class="sm" onClick={toggleFull}>
          {full ? <Icon.Minimize /> : <Icon.Maximize />}
        </IconButton>
        <button class="btn sm danger" onClick={() => v.releaseControl()}>{t("rc2.release")}</button>
      </div>
    </>
  );
}

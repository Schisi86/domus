// Remote control UI: the host allows control with a password; a viewer takes
// over mouse, keyboard or a controller over the call's data channel. Only works
// in the desktop app (input is injected by the Tauri backend).

import { useEffect, useRef, useState } from "preact/hooks";
import type { VoiceSession } from "../rtc/voice";
import { t } from "../i18n";
import { toast } from "../state/app";
import { isTauri } from "../platform";
import { Icon, Popover, promptDialog } from "./components";

/** Browser KeyboardEvent.code → Windows virtual-key code (the common keys). */
const VK: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17,
  AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34,
  End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45,
  Delete: 46, MetaLeft: 91, MetaRight: 92, ContextMenu: 93,
  Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Backslash: 220, Semicolon: 186, Quote: 222,
  Backquote: 192, Comma: 188, Period: 190, Slash: 191,
};
function vkFor(e: KeyboardEvent): number {
  if (e.code.startsWith("Key")) return e.code.charCodeAt(3); // KeyA → 'A'
  if (e.code.startsWith("Digit")) return e.code.charCodeAt(5); // Digit1 → '1'
  if (e.code.startsWith("Numpad") && e.code.length === 7) return 96 + (e.code.charCodeAt(6) - 48); // Numpad0..9
  if (/^F\d{1,2}$/.test(e.code)) return 111 + Number(e.code.slice(1)); // F1 → 112
  return VK[e.code] ?? e.keyCode ?? 0;
}

/** Host: toggle remote control and set a password (shown while sharing screen). */
export function ControlHostButton({ v }: { v: VoiceSession }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const on = v.remoteAllowed.value;
  const sharing = v.sharingScreen.value;
  return (
    <>
      <button
        class={`round-btn${on ? " on" : ""}`}
        title={!sharing ? t("rc2.needShare") : on ? t("rc2.allowed") : t("rc2.allow")}
        disabled={!sharing}
        onClick={(e) => setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())}
      >
        <Icon.Remote />
      </button>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)}>
          <div class="rc-menu">
            <div class="row"><b class="grow small">{t("rc2.title")}</b></div>
            <div class="faint xs">{t("rc2.menuHint")}</div>
            {!isTauri && <div class="notice warn xs">{t("rc2.desktopOnly")}</div>}
            <label class="rc-field">
              <span class="label" style={{ margin: "0px" }}>{t("rc2.password")}</span>
              <input
                class="input"
                type="text"
                value={v.remotePassword.value}
                placeholder={t("rc2.passwordPh")}
                onInput={(e) => v.setRemote(v.remoteAllowed.value, (e.target as HTMLInputElement).value)}
              />
            </label>
            <button
              class={`btn ${on ? "danger" : "primary"} block`}
              disabled={!on && !v.remotePassword.value.trim()}
              onClick={() => v.setRemote(!on)}
            >
              {on ? t("rc2.turnOff") : t("rc2.turnOn")}
            </button>
            {v.controlledBy.value !== null && (
              <div class="rc-active">
                <span class="grow">{t("rc2.controlledBy", { name: v.server.memberName(v.controlledBy.value) })}</span>
                <button class="btn sm danger" onClick={() => v.revokeControl()}>{t("rc2.revoke")}</button>
              </div>
            )}
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
    <div class="notice danger rc-banner" style={{ margin: "0 14px 6px" }}>
      <Icon.Remote size={16} />
      <span class="grow">{t("rc2.controlledBy", { name: v.server.memberName(by) })}</span>
      <button class="btn sm" onClick={() => v.revokeControl()}>{t("rc2.stop")}</button>
    </div>
  );
}

/** Viewer: ask for the password and request control of `uid`. */
export async function takeControl(v: VoiceSession, uid: number) {
  if (!isTauri) return toast(t("rc2.desktopOnly"), undefined, "warn");
  const pw = await promptDialog({ title: t("rc2.joinTitle", { name: v.server.memberName(uid) }), label: t("rc2.password"), body: t("rc2.joinHint"), confirm: t("rc2.request") });
  if (pw === null) return;
  v.requestControl(uid, pw);
}

/** Viewer: transparent surface over the controlled screen that captures input. */
export function ControlSurface({ v, uid }: { v: VoiceSession; uid: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);

  // Normalized position (0..1) inside the host's video content box (letterbox-aware).
  const norm = (clientX: number, clientY: number) => {
    const host = ref.current?.parentElement;
    const video = host?.querySelector("video") as HTMLVideoElement | null;
    if (!video) return null;
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || r.width;
    const vh = video.videoHeight || r.height;
    const scale = Math.min(r.width / vw, r.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = r.left + (r.width - dw) / 2;
    const oy = r.top + (r.height - dh) / 2;
    const x = (clientX - ox) / dw;
    const y = (clientY - oy) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!active) return;
      e.preventDefault();
      v.sendInput([{ t: "k", c: vkFor(e), d: true }]);
    };
    const up = (e: KeyboardEvent) => {
      if (!active) return;
      e.preventDefault();
      v.sendInput([{ t: "k", c: vkFor(e), d: false }]);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [active]);

  // Controller support: left stick → cursor, buttons → clicks / keys, right stick → scroll.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let cx = 0.5;
    let cy = 0.5;
    const prev: boolean[] = [];
    const map: Record<number, { t: "b"; b: number } | { t: "k"; c: number }> = {
      0: { t: "b", b: 0 }, 1: { t: "b", b: 2 }, 2: { t: "k", c: 32 }, 3: { t: "k", c: 13 },
      12: { t: "k", c: 38 }, 13: { t: "k", c: 40 }, 14: { t: "k", c: 37 }, 15: { t: "k", c: 39 },
    };
    const loop = () => {
      const gp = navigator.getGamepads?.().find((g) => g);
      if (gp) {
        const dead = (n: number) => (Math.abs(n) > 0.18 ? n : 0);
        cx = Math.max(0, Math.min(1, cx + dead(gp.axes[0] ?? 0) * 0.02));
        cy = Math.max(0, Math.min(1, cy + dead(gp.axes[1] ?? 0) * 0.02));
        if (dead(gp.axes[0] ?? 0) || dead(gp.axes[1] ?? 0)) v.sendMove(cx, cy);
        const wy = dead(gp.axes[3] ?? 0);
        if (wy) v.sendInput([{ t: "w", dy: -wy }]);
        gp.buttons.forEach((b, i) => {
          const on = b.pressed;
          if (on !== (prev[i] ?? false) && map[i]) v.sendInput([{ ...map[i], d: on }]);
          prev[i] = on;
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      ref={ref}
      class={`rc-surface${active ? " active" : ""}`}
      data-uid={uid}
      tabIndex={0}
      title={active ? t("rc2.surfaceActive") : t("rc2.surfaceClick")}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLElement).focus();
        if (!active) {
          setActive(true);
          return;
        }
        const n = norm(e.clientX, e.clientY);
        if (n) {
          v.sendInput([{ t: "m", x: n.x, y: n.y }]);
          v.sendInput([{ t: "b", b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0, d: true }]);
        }
      }}
      onPointerUp={(e) => {
        if (!active) return;
        v.sendInput([{ t: "b", b: e.button === 1 ? 1 : e.button === 2 ? 2 : 0, d: false }]);
      }}
      onPointerMove={(e) => {
        if (!active) return;
        const n = norm(e.clientX, e.clientY);
        if (n) v.sendMove(n.x, n.y);
      }}
      onWheel={(e) => {
        if (!active) return;
        e.preventDefault();
        v.sendInput([{ t: "w", dy: e.deltaY > 0 ? -1 : 1 }]);
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div class="rc-surface-bar">
        <Icon.Remote size={14} />
        <span class="grow">{active ? t("rc2.surfaceActive") : t("rc2.surfaceClick")}</span>
        <button
          class="btn sm"
          onClick={(e) => {
            e.stopPropagation();
            v.releaseControl();
          }}
        >
          {t("rc2.release")}
        </button>
      </div>
    </div>
  );
}

// Screen share options: resolution, frame rate, content type, bitrate and
// system audio – chosen in a small menu before the share starts and
// adjustable while it runs.

import { useState } from "preact/hooks";
import { settings, updateSettings, type ScreenOpts, type ScreenRes } from "../state/app";
import { SCREEN_FPS, screenParams, type VoiceSession } from "../rtc/voice";
import { t } from "../i18n";
import { Icon, Popover, Toggle } from "./components";

const RES: { id: ScreenRes; label: string }[] = [
  { id: "720", label: "720p" },
  { id: "1080", label: "1080p" },
  { id: "1440", label: "1440p" },
  { id: "2160", label: "4K" },
  { id: "source", label: "" },
];

const PRESETS: { id: string; o: Omit<ScreenOpts, "kbps"> }[] = [
  { id: "sc.pEco", o: { res: "720", fps: 15, content: "detail" } },
  { id: "sc.pStd", o: { res: "1080", fps: 30, content: "auto" } },
  { id: "sc.pSmooth", o: { res: "1080", fps: 60, content: "motion" } },
  { id: "sc.pSharp", o: { res: "1440", fps: 30, content: "detail" } },
  { id: "sc.pHigh", o: { res: "1440", fps: 60, content: "motion" } },
  { id: "sc.pMax", o: { res: "source", fps: 60, content: "motion" } },
];

const BITRATES = [0, 1000, 2500, 4000, 6000, 8000, 12000, 16000];

export function resLabel(res: ScreenRes) {
  return res === "source" ? t("sc.source") : (RES.find((r) => r.id === res)?.label ?? res);
}

export function screenSummary(o: ScreenOpts = settings.value.screen) {
  return `${resLabel(o.res)} · ${o.fps} FPS`;
}

const mbit = (kbps: number) => (kbps / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 });

/** The option panel itself; used in the popover and in the settings dialog. */
export function ScreenOptions({ viewers }: { viewers?: number }) {
  const o = settings.value.screen;
  const set = (patch: Partial<ScreenOpts>) => updateSettings({ screen: { ...o, ...patch } });
  const p = screenParams(o);
  const total = viewers && viewers > 1 ? p.kbps * viewers : 0;
  return (
    <>
      <div>
        <span class="label">{t("sc.presets")}</span>
        <div class="preset-grid">
          {PRESETS.map((pr) => {
            const on = pr.o.res === o.res && pr.o.fps === o.fps && pr.o.content === o.content;
            return (
              <button key={pr.id} class={`preset${on ? " on" : ""}`} onClick={() => set(pr.o)}>
                {t(pr.id as never)}
                <span>{resLabel(pr.o.res)} · {pr.o.fps}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <span class="label">{t("sc.resolution")}</span>
        <div class="chips">
          {RES.map((r) => (
            <button key={r.id} class={`chip${o.res === r.id ? " on" : ""}`} onClick={() => set({ res: r.id })}>{resLabel(r.id)}</button>
          ))}
        </div>
      </div>
      <div>
        <span class="label">{t("sc.fps")}</span>
        <div class="chips">
          {SCREEN_FPS.map((f) => (
            <button key={f} class={`chip${o.fps === f ? " on" : ""}`} onClick={() => set({ fps: f })}>{f} FPS</button>
          ))}
        </div>
      </div>
      <div>
        <span class="label">{t("sc.content")}</span>
        <div class="chips">
          {(["auto", "detail", "motion"] as const).map((c) => (
            <button key={c} class={`chip${o.content === c ? " on" : ""}`} onClick={() => set({ content: c })}>{t(`sc.${c}` as never)}</button>
          ))}
        </div>
      </div>
      <div>
        <span class="label">{t("sc.bitrate")}</span>
        <select class="select" value={String(o.kbps)} onChange={(e) => set({ kbps: Number((e.target as HTMLSelectElement).value) })}>
          {BITRATES.map((b) => (
            <option key={b} value={String(b)}>{b === 0 ? t("sc.bitrateAuto", { mbit: mbit(screenParams({ ...o, kbps: 0 }).kbps) }) : `${mbit(b)} Mbit/s`}</option>
          ))}
        </select>
      </div>
      <Toggle checked={settings.value.screenAudio} onChange={(x) => updateSettings({ screenAudio: x })} label={t("screen.audio")} />
      <div class="screen-est">
        <span>{t("sc.upload")}</span>
        <b>{total ? t("sc.uploadTotal", { mbit: mbit(p.kbps), total: mbit(total), n: viewers! }) : `≤ ${mbit(p.kbps)} Mbit/s`}</b>
      </div>
      {total > 15000 && <div class="notice warn small">{t("sc.highWarn")}</div>}
      <div class="faint xs">{t("sc.hint")}</div>
    </>
  );
}

function ScreenMenu({ v, anchor, onClose }: { v: VoiceSession; anchor: DOMRect; onClose: () => void }) {
  const sharing = v.sharingScreen.value;
  const viewers = v.peerIds().length;
  return (
    <Popover anchor={anchor} onClose={onClose}>
      <div class="screen-menu">
        <h4><Icon.Screen size={17} /> {sharing ? t("sc.titleLive") : t("sc.title")}</h4>
        <ScreenOptions viewers={viewers} />
        <button
          class="btn primary lg block"
          onClick={() => {
            onClose();
            void (sharing ? v.applyScreenProfile() : v.startScreen());
          }}
        >
          {sharing ? <><Icon.Check size={15} /> {t("sc.apply")}</> : <><Icon.Screen size={15} /> {t("sc.start")}</>}
        </button>
      </div>
    </Popover>
  );
}

/**
 * Share button: opens the options menu before starting; while sharing it stops
 * the share, and the small gear next to it reopens the menu to adjust quality.
 */
export function ScreenShareControl({ v, disabled, variant }: { v: VoiceSession; disabled?: boolean; variant: "round" | "panel" }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const sharing = v.sharingScreen.value;
  const open = (e: MouseEvent) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
  const title = disabled ? t("common.noPermission") : sharing ? t("voice.stopShare") : t("voice.shareScreenLong");
  const cls = variant === "round" ? `round-btn${sharing ? " on" : ""}` : `btn${sharing ? " on" : ""}`;
  return (
    <span class="share-group">
      <button class={cls} title={title} aria-label={title} disabled={disabled} onClick={(e) => (sharing ? void v.stopScreen() : open(e))}>
        {sharing ? <Icon.ScreenOff /> : <Icon.Screen />}
      </button>
      {sharing && (
        <button class="share-caret" title={t("sc.change")} aria-label={t("sc.change")} onClick={open}>
          <Icon.Gear size={12} />
        </button>
      )}
      {anchor && <ScreenMenu v={v} anchor={anchor} onClose={() => setAnchor(null)} />}
    </span>
  );
}

/** Header chip while sharing: shows the current quality and opens the menu. */
export function ScreenQualityChip({ v }: { v: VoiceSession }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button class="btn sm" title={t("sc.change")} onClick={(e) => setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <Icon.Sliders size={13} /> {screenSummary()}
      </button>
      {anchor && <ScreenMenu v={v} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}

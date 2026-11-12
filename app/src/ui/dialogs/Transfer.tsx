// "Move profile": show a QR code on this device, or scan the one of another
// device (phone ↔ PC, both directions). See state/link.ts for the protocol.

import { useEffect, useState } from "preact/hooks";
import { closeModal, linkedDevices, servers, toast } from "../../state/app";
import { applyLink, decodeLink, prepareLink, LINK_PREFIX, type LinkPayload, type LinkResult, type PreparedLink } from "../../state/link";
import { errorText, t } from "../../i18n";
import { Field, Icon, Modal, Spinner, Toggle, copyText } from "../components";
import { QrCode, QrScanner } from "../qr";

type Mode = "send" | "receive";

function mmss(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Send() {
  const [withSettings, setWithSettings] = useState(true);
  const [link, setLink] = useState<PreparedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [since] = useState(Date.now());
  const make = async () => {
    setBusy(true);
    try {
      setLink(await prepareLink(withSettings));
    } catch (e) {
      toast(t("common.error"), errorText(e), "error");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => void make(), [withSettings]);
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const left = link ? link.payload.x - now : 0;
  const expired = !!link && link.payload.s.length > 0 && left <= 0;
  const fresh = linkedDevices.value.filter((d) => d.at >= since);

  return (
    <div class="col transfer">
      <Toggle checked={withSettings} onChange={setWithSettings} label={t("move.withSettings")} desc={t("move.withSettingsDesc")} />
      {busy && !link && <div class="row center" style={{ padding: "40px" }}><Spinner /></div>}
      {link && link.payload.s.length === 0 && <div class="notice warn">{t("move.nothing")}</div>}
      {link && link.payload.s.length > 0 && (
        <div class="transfer-qr">
          <div class={`qr-wrap${expired ? " expired" : ""}`}>
            <QrCode text={link.text} size={232} label={t("move.qrLabel")} />
            {expired && (
              <button class="btn primary qr-renew" onClick={() => void make()}><Icon.Refresh /> {t("move.renew")}</button>
            )}
          </div>
          <div class="col grow" style={{ gap: "10px", minWidth: "200px" }}>
            <ol class="steps">
              <li>{t("move.step1")}</li>
              <li>{t("move.step2")}</li>
              <li>{t("move.step3")}</li>
            </ol>
            <div class={`badge ${expired ? "warn" : "ok"}`} style={{ alignSelf: "flex-start" }}>
              <Icon.Clock size={14} /> {expired ? t("move.expired") : t("move.validFor", { time: mmss(left) })}
            </div>
            <div class="row wrap" style={{ gap: "8px" }}>
              <button class="btn sm outline" disabled={expired} onClick={() => { copyText(link.text); toast(t("move.copied"), t("move.copiedBody"), "ok", 4000); }}><Icon.Copy /> {t("move.copyText")}</button>
              <button class="btn sm ghost" disabled={busy} onClick={() => void make()}><Icon.Refresh /> {t("move.renew")}</button>
            </div>
          </div>
        </div>
      )}
      {link && (link.payload.s.length > 0 || link.skipped.length > 0) && (
        <div class="card col" style={{ gap: "6px" }}>
          {link.payload.s.length > 0 && <div class="label" style={{ margin: "0px" }}>{t("move.included", { n: link.payload.s.length })}</div>}
          {link.payload.s.map((s) => (
            <div key={s.c} class="row small" style={{ gap: "8px" }}>
              <Icon.ServerIcon size={16} />
              <span class="grow ellipsis">{s.n} <span class="faint">· {s.u}</span></span>
              <span class="faint xs mono ellipsis" style={{ maxWidth: "45%" }}>{s.a[0]}</span>
            </div>
          ))}
          {link.skipped.map((s) => (
            <div key={s.name} class="row small faint" style={{ gap: "8px" }}>
              <Icon.X size={16} />
              <span class="grow ellipsis">{s.name}</span>
              <span class="xs">{s.why}</span>
            </div>
          ))}
        </div>
      )}
      {fresh.length > 0 && (
        <div class="notice ok">
          <Icon.Check size={16} /> {t("move.done", { device: fresh[fresh.length - 1].device || t("move.unnamed"), n: fresh.length })}
        </div>
      )}
      <div class="faint xs">{t("move.secret")}</div>
    </div>
  );
}

function Receive({ initial }: { initial?: string }) {
  const [withSettings, setWithSettings] = useState(true);
  const [scan, setScan] = useState(!initial);
  const [text, setText] = useState("");
  const [payload, setPayload] = useState<LinkPayload | null>(() => (initial ? decodeLink(initial) : null));
  const [results, setResults] = useState<LinkResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const take = (raw: string) => {
    const p = decodeLink(raw);
    if (!p) return setError(t("move.invalid"));
    if (!p.s.length) return setError(t("move.empty"));
    setError(null);
    setScan(false);
    setPayload(p);
  };

  const apply = async () => {
    if (!payload) return;
    setBusy(true);
    setResults([]);
    try {
      const r = await applyLink(payload, withSettings, setResults);
      const ok = r.filter((x) => x.state === "ok").length;
      if (ok) toast(t("move.received"), t("move.receivedBody", { n: ok }), "ok");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (payload) {
    const left = payload.x - Date.now();
    return (
      <div class="col transfer">
        <div class="card col" style={{ gap: "8px" }}>
          <div class="label" style={{ margin: "0px" }}>{t("move.from", { device: payload.d || t("move.unnamed") })}</div>
          {payload.s.map((s, i) => {
            const r = results?.[i];
            return (
              <div key={s.c} class="row small" style={{ gap: "8px" }}>
                {r ? (r.state === "ok" ? <Icon.Check size={16} class="icon ok-text" /> : r.state === "exists" ? <Icon.Check size={16} class="icon faint" /> : <Icon.X size={16} class="icon danger-text" />) : busy && results && results.length === i ? <Spinner /> : <Icon.ServerIcon size={16} />}
                <span class="grow ellipsis">{s.n} <span class="faint">· {s.u}</span></span>
                <span class="xs faint">{r ? (r.state === "ok" ? t("move.stOk") : r.state === "exists" ? t("move.stExists") : r.detail ?? t("move.stFailed")) : ""}</span>
              </div>
            );
          })}
        </div>
        {!results && <Toggle checked={withSettings} disabled={!payload.p} onChange={setWithSettings} label={t("move.takeSettings")} desc={t("move.takeSettingsDesc")} />}
        {!results && left < 0 && <div class="notice warn small">{t("move.maybeExpired")}</div>}
        {error && <div class="error-text">{error}</div>}
        <div class="row" style={{ gap: "8px" }}>
          {!results && <button class="btn primary" disabled={busy} onClick={() => void apply()}>{busy ? <Spinner /> : t("move.signIn", { n: payload.s.length })}</button>}
          {results && !busy && <button class="btn primary" onClick={closeModal}>{t("common.done")}</button>}
          {!busy && <button class="btn ghost" onClick={() => { setPayload(null); setResults(null); setScan(true); }}>{t("move.scanOther")}</button>}
        </div>
      </div>
    );
  }

  return (
    <div class="col transfer">
      <div class="faint small">{t("move.receiveHint")}</div>
      {scan ? (
        <QrScanner onResult={take} accept={(x) => x.trim().startsWith(LINK_PREFIX)} />
      ) : (
        <button class="btn outline" onClick={() => setScan(true)}><Icon.Camera /> {t("move.scan")}</button>
      )}
      <Field label={t("move.pasteLabel")} error={error}>
        <div class="row" style={{ gap: "8px" }}>
          <input class="input mono small grow" value={text} placeholder={`${LINK_PREFIX}…`} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && take(text)} />
          <button class="btn" disabled={!text.trim()} onClick={() => take(text)}>{t("common.next")}</button>
        </div>
      </Field>
    </div>
  );
}

export function TransferDialog({ mode: start, initial }: { mode?: Mode; initial?: string }) {
  const [mode, setMode] = useState<Mode>(start ?? (servers.value.length ? "send" : "receive"));
  return (
    <Modal title={t("move.title")} sub={t("move.sub")} class="transfer-modal" footer={<button class="btn ghost" onClick={closeModal}>{t("common.close")}</button>}>
      <div class="tabs">
        <button class={mode === "send" ? "active" : ""} disabled={!servers.value.length} onClick={() => setMode("send")}><Icon.Upload size={16} /> {t("move.send")}</button>
        <button class={mode === "receive" ? "active" : ""} onClick={() => setMode("receive")}><Icon.Download size={16} /> {t("move.receive")}</button>
      </div>
      {mode === "send" ? <Send /> : <Receive initial={initial} />}
    </Modal>
  );
}

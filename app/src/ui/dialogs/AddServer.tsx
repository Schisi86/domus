// Add a server (address or invite link), verify its certificate, sign in or register.
// Also used to repair a saved server (expired session, certificate change).

import { useState } from "preact/hooks";
import { addServer, closeModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { SavedServer, ServerInfo } from "../../types";
import { errorText, regMode, t } from "../../i18n";
import { isNetError, normalizeAddress, parseInvite, transport, type NetError } from "../../net/transport";
import { Field, Icon, Modal, Spinner } from "../components";
import { isAndroidApp, isIOSApp, isTauri } from "../../platform";
import { QrScanner } from "../qr";
import { LINK_PREFIX } from "../../state/link";
import { TransferDialog } from "./Transfer";
import { openModal } from "../../state/app";

type Step = "address" | "cert" | "auth";

function fmtFp(fp: string) {
  return fp.match(/.{1,2}/g)?.join(":") ?? fp;
}

/** Explains the usual reasons when a server cannot be reached. */
function connectHelp(address: string, e: unknown): string | null {
  if (!isNetError(e) || (e.kind !== "timeout" && e.kind !== "connect")) return null;
  const n = normalizeAddress(address);
  const port = n?.base.split(":").pop() ?? "7878";
  const local = !!n && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|localhost|127\.)/.test(n.host);
  if (e.kind === "connect" && /refused|verweigert|10061|actively/i.test(e.message)) return t("add.helpRefused", { port });
  return local ? t("add.helpTimeout") : `${t("add.helpTimeout")} ${t("add.helpInternet")}`;
}

export function deviceName() {
  if (isIOSApp) {
    const ipad = /iPad/i.test(navigator.userAgent) || (!/iPhone/i.test(navigator.userAgent) && (navigator.maxTouchPoints ?? 0) > 1);
    return ipad ? "Domus iOS (iPad)" : "Domus iOS (iPhone)";
  }
  if (isAndroidApp) {
    // "Android 15; Pixel 9" → model name from the user agent when available.
    const m = /Android [\d.]+; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent);
    const model = m?.[1]?.trim();
    return `Domus Android${model && model !== "K" ? ` (${model})` : ""}`;
  }
  return isTauri ? "Domus Desktop (Windows)" : `Browser (${navigator.userAgent.includes("Edg") ? "Edge" : "Web"})`;
}

export function AddServerDialog({ reauth, prefill }: { reauth?: ServerStore; prefill?: { address: string; invite?: string; fingerprint?: string | null } }) {
  const saved = reauth?.saved.value;
  const certProblem = !!reauth && reauth.conn.state.value.startsWith("cert");
  const [step, setStep] = useState<Step>(certProblem ? "cert" : reauth ? "auth" : "address");
  const [address, setAddress] = useState(prefill?.address ?? saved?.address ?? "");
  const [fingerprint, setFingerprint] = useState<string | null>(prefill?.fingerprint ?? saved?.fingerprint ?? null);
  const [certErr, setCertErr] = useState<NetError | null>(reauth?.conn.certError.value ?? null);
  const [info, setInfo] = useState<ServerInfo | null>(reauth?.info.value ?? null);
  const [mode, setMode] = useState<"login" | "register">(prefill?.invite ? "register" : "login");
  const [username, setUsername] = useState(saved?.username ?? "");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [invite, setInvite] = useState(prefill?.invite ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [help, setHelp] = useState<string | null>(null);
  const [pendingNote, setPendingNote] = useState(false);
  const [scanning, setScanning] = useState(false);

  const probe = async (addr: string, fp: string | null) => {
    setBusy(true);
    setError(null);
    setHelp(null);
    try {
      const r = await transport.http<ServerInfo>({ address: addr, fingerprint: fp }, "GET", "/api/v1/info");
      if (r.status !== 200 || !r.body?.name) throw { kind: "connect", message: t("add.notNexus", { status: r.status }) } satisfies NetError;
      setInfo(r.body);
      setStep("auth");
    } catch (e) {
      if (isNetError(e) && (e.kind === "untrusted" || e.kind === "mismatch")) {
        setCertErr(e);
        setStep("cert");
      } else {
        setError(errorText(e));
        setHelp(connectHelp(addr, e));
      }
    } finally {
      setBusy(false);
    }
  };

  const submitAddress = () => {
    const inv = parseInvite(address);
    if (inv) {
      setAddress(inv.address);
      setInvite(inv.code);
      setMode("register");
      setFingerprint(inv.fingerprint);
      return probe(inv.address, inv.fingerprint);
    }
    if (!normalizeAddress(address)) return setError(t("add.invalidAddress"));
    return probe(address, fingerprint);
  };

  const trustCert = () => {
    if (!certErr) return;
    const fp = certErr.kind === "untrusted" ? certErr.fingerprint : certErr.kind === "mismatch" ? certErr.actual : null;
    setFingerprint(fp);
    setCertErr(null);
    void probe(address, fp);
  };

  const auth = async () => {
    setError(null);
    if (mode === "register" && password !== password2) return setError(t("add.pwMismatch"));
    setBusy(true);
    try {
      const path = mode === "login" ? "/api/v1/auth/login" : "/api/v1/auth/register";
      const body = mode === "login" ? { username, password, device: deviceName() } : { username, password, invite: invite || null, device: deviceName() };
      const r = await transport.http({ address, fingerprint }, "POST", path, null, body);
      if (r.status !== 200) throw r.body?.error ?? { code: "INTERNAL", msg: `HTTP ${r.status}` };
      if (r.body.pending) {
        setPendingNote(true);
        setMode("login");
        return;
      }
      const entry: SavedServer = {
        id: saved?.id ?? crypto.randomUUID(),
        address,
        fingerprint,
        name: info?.name ?? address,
        username: r.body.user.username,
        token: r.body.token,
        hosted: saved?.hosted,
      };
      addServer(entry);
      closeModal();
      toast(mode === "login" ? t("add.signedIn") : t("add.created"), `${entry.username} @ ${entry.name}`, "ok");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (step === "cert" && certErr) {
    const mismatch = certErr.kind === "mismatch";
    const fp = certErr.kind === "untrusted" ? certErr.fingerprint : certErr.kind === "mismatch" ? certErr.actual : "";
    return (
      <Modal
        title={mismatch ? t("cert.changedTitle") : t("cert.unknownTitle")}
        footer={
          <>
            <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
            <button class={`btn ${mismatch ? "danger" : "primary"}`} onClick={trustCert}>{mismatch ? t("cert.trustAnyway") : t("cert.trust")}</button>
          </>
        }
      >
        <div class={`notice ${mismatch ? "danger" : "warn"}`}>{mismatch ? t("cert.changedText") : t("cert.unknownText")}</div>
        <Field label={t("cert.fingerprint")}>
          <div class="card mono small selectable" style={{ wordBreak: "break-all" }}>{fmtFp(fp)}</div>
        </Field>
        {certErr.kind === "mismatch" && (
          <Field label={t("cert.previous")}>
            <div class="card mono small selectable" style={{ wordBreak: "break-all", opacity: 0.7 }}>{fmtFp(certErr.expected)}</div>
          </Field>
        )}
      </Modal>
    );
  }

  if (step === "address") {
    return (
      <Modal
        title={t("rail.add")}
        sub={t("add.sub")}
        footer={
          <>
            <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
            <button class="btn primary" disabled={busy || !address.trim()} onClick={() => void submitAddress()}>{busy ? <Spinner /> : t("common.next")}</button>
          </>
        }
      >
        <Field label={t("add.addressLabel")} hint={t("add.addressHint")} error={error}>
          <div class="row" style={{ gap: "8px" }}>
            <input class="input grow" autoFocus={!scanning} value={address} onInput={(e) => setAddress((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && void submitAddress()} placeholder={t("add.address")} />
            <button class={`btn ${scanning ? "primary" : "outline"}`} title={t("add.scan")} onClick={() => setScanning(!scanning)}><Icon.Qr size={18} /></button>
          </div>
        </Field>
        {scanning && (
          <QrScanner
            accept={(x) => !!parseInvite(x) || x.trim().startsWith(LINK_PREFIX)}
            onResult={(x) => {
              setScanning(false);
              if (x.trim().startsWith(LINK_PREFIX)) return openModal(<TransferDialog mode="receive" initial={x} />);
              setAddress(x);
              const inv = parseInvite(x)!;
              setAddress(inv.address);
              setInvite(inv.code);
              setMode("register");
              setFingerprint(inv.fingerprint);
              void probe(inv.address, inv.fingerprint);
            }}
          />
        )}
        {help && <div class="notice warn small">{help}</div>}
        <div class="faint xs">{t("add.defaults")}</div>
        <button class="btn ghost sm" style={{ alignSelf: "flex-start" }} onClick={() => openModal(<TransferDialog mode="receive" />)}>
          <Icon.Phone size={16} /> {t("add.fromDevice")}
        </button>
      </Modal>
    );
  }

  const reg = info?.registration_mode;
  return (
    <Modal
      title={info?.name ?? address}
      sub={
        <>
          {address}
          {fingerprint && <span title={fmtFp(fingerprint)}> · 🔒 {t("add.certChecked")}</span>}
          {info?.description && <div style={{ marginTop: "6px" }}>{info.description}</div>}
        </>
      }
      footer={
        <>
          <button class="btn ghost" onClick={closeModal}>{t("common.cancel")}</button>
          <button class="btn primary" disabled={busy || !username || !password} onClick={() => void auth()}>
            {busy ? <Spinner /> : mode === "login" ? t("add.signIn") : t("add.createAccount")}
          </button>
        </>
      }
    >
      <div class="tabs">
        <button class={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>{t("add.signIn")}</button>
        <button class={mode === "register" ? "active" : ""} onClick={() => setMode("register")} disabled={reg === "closed" && !invite}>{t("add.register")}</button>
      </div>
      {pendingNote && <div class="notice ok">{t("add.pendingNote")}</div>}
      {reauth && reauth.conn.state.value === "auth_failed" && <div class="notice warn">{t("add.sessionExpired")}</div>}
      <form onSubmit={(e) => { e.preventDefault(); void auth(); }} class="col" style={{ gap: "12px" }}>
        <Field label={t("add.username")}>
          <input class="input" autoFocus autoComplete="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label={t("add.password")} hint={mode === "register" ? t("add.pwHint") : undefined}>
          <input class="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </Field>
        {mode === "register" && (
          <>
            <Field label={t("add.password2")}>
              <input class="input" type="password" autoComplete="new-password" value={password2} onInput={(e) => setPassword2((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label={t("add.inviteCode")} hint={reg ? t("add.regMode", { mode: regMode(reg) }) : undefined}>
              <input class="input mono" value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value.toUpperCase())} placeholder={reg === "invite" || reg === "closed" ? t("add.required") : t("add.optional")} />
            </Field>
          </>
        )}
        <button type="submit" hidden />
      </form>
      {error && <div class="error-text">{error}</div>}
      <div class="faint xs">{t("add.pwPrivacy")}</div>
    </Modal>
  );
}

// Add a server (address or invite link), verify its certificate, sign in or register.
// Also used to repair a saved server (expired session, certificate change).

import { useState } from "preact/hooks";
import { addServer, closeModal, toast } from "../../state/app";
import type { ServerStore } from "../../state/server";
import type { SavedServer, ServerInfo } from "../../types";
import { errorText, REG_MODES } from "../../i18n";
import { isNetError, normalizeAddress, parseInvite, transport, type NetError } from "../../net/transport";
import { Field, Modal, Spinner } from "../components";
import { isTauri } from "../../platform";

type Step = "address" | "cert" | "auth";

function fmtFp(fp: string) {
  return fp.match(/.{1,2}/g)?.join(":") ?? fp;
}

export function deviceName() {
  return isTauri ? "NexusTalk Desktop (Windows)" : `Browser (${navigator.userAgent.includes("Edg") ? "Edge" : "Web"})`;
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
  const [pendingNote, setPendingNote] = useState(false);

  const probe = async (addr: string, fp: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await transport.http<ServerInfo>({ address: addr, fingerprint: fp }, "GET", "/api/v1/info");
      if (r.status !== 200 || !r.body?.name) throw { kind: "connect", message: `Kein NexusTalk-Server (HTTP ${r.status})` } satisfies NetError;
      setInfo(r.body);
      setStep("auth");
    } catch (e) {
      if (isNetError(e) && (e.kind === "untrusted" || e.kind === "mismatch")) {
        setCertErr(e);
        setStep("cert");
      } else setError(errorText(e));
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
    if (!normalizeAddress(address)) return setError("Bitte eine gültige Adresse eingeben, z. B. 192.168.1.20 oder chat.example.org:7878");
    return probe(address, fingerprint);
  };

  const trustCert = () => {
    if (!certErr || certErr.kind === "bad_url") return;
    const fp = certErr.kind === "untrusted" ? certErr.fingerprint : certErr.kind === "mismatch" ? certErr.actual : null;
    setFingerprint(fp);
    setCertErr(null);
    void probe(address, fp);
  };

  const auth = async () => {
    setError(null);
    if (mode === "register" && password !== password2) return setError("Die Passwörter stimmen nicht überein.");
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
      toast(mode === "login" ? "Angemeldet" : "Konto erstellt", `${entry.username} @ ${entry.name}`, "ok");
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
        title={mismatch ? "Achtung: Zertifikat hat sich geändert" : "Unbekanntes Serverzertifikat"}
        footer={
          <>
            <button class="btn ghost" onClick={closeModal}>Abbrechen</button>
            <button class={`btn ${mismatch ? "danger" : "primary"}`} onClick={trustCert}>
              {mismatch ? "Neuem Zertifikat trotzdem vertrauen" : "Zertifikat vertrauen"}
            </button>
          </>
        }
      >
        <div class={`notice ${mismatch ? "danger" : "warn"}`}>
          {mismatch
            ? "Der Server weist sich mit einem anderen Zertifikat aus als beim letzten Mal. Das ist normal, wenn der Betreiber das Zertifikat erneuert hat – es kann aber auch bedeuten, dass jemand die Verbindung abfängt. Frage den Betreiber nach dem Fingerabdruck, bevor du fortfährst."
            : "Dieser Server verwendet ein selbst signiertes Zertifikat. Vergleiche den Fingerabdruck mit dem, den der Serverbetreiber dir genannt hat (er steht auch im Einladungslink). Nach dem Vertrauen wird er gespeichert und bei jeder Verbindung geprüft."}
        </div>
        <Field label="SHA-256-Fingerabdruck">
          <div class="card mono small selectable" style={{ wordBreak: "break-all" }}>{fmtFp(fp)}</div>
        </Field>
        {mismatch && certErr.kind === "mismatch" && (
          <Field label="Bisher gespeichert">
            <div class="card mono small selectable" style={{ wordBreak: "break-all", opacity: 0.7 }}>{fmtFp(certErr.expected)}</div>
          </Field>
        )}
      </Modal>
    );
  }

  if (step === "address") {
    return (
      <Modal
        title="Server hinzufügen"
        sub="Gib die Adresse eines NexusTalk-Servers oder einen Einladungslink ein."
        footer={
          <>
            <button class="btn ghost" onClick={closeModal}>Abbrechen</button>
            <button class="btn primary" disabled={busy || !address.trim()} onClick={() => void submitAddress()}>
              {busy ? <Spinner /> : "Weiter"}
            </button>
          </>
        }
      >
        <Field label="Adresse oder Einladungslink" hint="Beispiele: 192.168.1.20 · chat.example.org:7878 · nexustalk://host:7878/ABCD1234#fp=…" error={error}>
          <input
            class="input"
            autoFocus
            value={address}
            onInput={(e) => setAddress((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => e.key === "Enter" && void submitAddress()}
            placeholder="Adresse"
          />
        </Field>
        <div class="faint xs">Ohne Angabe wird Port 7878 und eine verschlüsselte Verbindung (TLS) verwendet. Für unverschlüsselte Testserver „http://“ voranstellen.</div>
      </Modal>
    );
  }

  const regMode = info?.registration_mode;
  return (
    <Modal
      title={info?.name ?? address}
      sub={
        <>
          {address}
          {fingerprint && <span title={fmtFp(fingerprint)}> · 🔒 Zertifikat geprüft</span>}
          {info?.description && <div style={{ marginTop: "6px" }}>{info.description}</div>}
        </>
      }
      footer={
        <>
          <button class="btn ghost" onClick={closeModal}>Abbrechen</button>
          <button class="btn primary" disabled={busy || !username || !password} onClick={() => void auth()}>
            {busy ? <Spinner /> : mode === "login" ? "Anmelden" : "Konto erstellen"}
          </button>
        </>
      }
    >
      <div class="tabs">
        <button class={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Anmelden</button>
        <button class={mode === "register" ? "active" : ""} onClick={() => setMode("register")} disabled={regMode === "closed" && !invite}>Registrieren</button>
      </div>
      {pendingNote && <div class="notice ok">Konto erstellt. Ein Moderator muss es noch freischalten – danach kannst du dich hier anmelden.</div>}
      {reauth && reauth.conn.state.value === "auth_failed" && <div class="notice warn">Deine Sitzung ist abgelaufen oder wurde beendet. Bitte melde dich erneut an.</div>}
      <form onSubmit={(e) => { e.preventDefault(); void auth(); }} class="col" style={{ gap: "12px" }}>
        <Field label="Benutzername">
          <input class="input" autoFocus autoComplete="username" value={username} onInput={(e) => setUsername((e.target as HTMLInputElement).value)} />
        </Field>
        <Field label="Passwort" hint={mode === "register" ? "Mindestens 8 Zeichen." : undefined}>
          <input class="input" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
        </Field>
        {mode === "register" && (
          <>
            <Field label="Passwort wiederholen">
              <input class="input" type="password" autoComplete="new-password" value={password2} onInput={(e) => setPassword2((e.target as HTMLInputElement).value)} />
            </Field>
            <Field label="Einladungscode" hint={regMode ? `Registrierung auf diesem Server: ${REG_MODES[regMode]}` : undefined}>
              <input class="input mono" value={invite} onInput={(e) => setInvite((e.target as HTMLInputElement).value.toUpperCase())} placeholder={regMode === "invite" || regMode === "closed" ? "erforderlich" : "optional"} />
            </Field>
          </>
        )}
        <button type="submit" hidden />
      </form>
      {error && <div class="error-text">{error}</div>}
      <div class="faint xs">Dein Passwort wird nur an diesen Server übertragen und nicht auf deinem Gerät gespeichert.</div>
    </Modal>
  );
}

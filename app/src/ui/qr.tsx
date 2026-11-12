// QR codes: drawing (qrcode-generator, MIT) and reading with the camera
// (jsQR, Apache-2.0). Both run fully on the device.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { t } from "../i18n";

/** Square QR code as crisp SVG; always dark on white so every camera reads it. */
export function QrCode({ text, size = 240, label }: { text: string; size?: number; label?: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, text.length > 300 ? "L" : "M");
    q.addData(text, "Byte");
    q.make();
    const n = q.getModuleCount();
    const m = 3; // quiet zone in modules
    let d = "";
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m} ${r + m}h1v1h-1z`;
    return { d, box: n + 2 * m };
  }, [text]);
  return (
    <svg class="qr" role="img" aria-label={label ?? "QR"} viewBox={`0 0 ${svg.box} ${svg.box}`} width={size} height={size} shape-rendering="crispEdges">
      <rect width={svg.box} height={svg.box} fill="#fff" />
      <path d={svg.d} fill="#000" />
    </svg>
  );
}

/** Live camera preview that reports the first QR code it reads. */
export function QrScanner({ onResult, accept }: { onResult: (text: string) => void; accept?: (text: string) => boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [cams, setCams] = useState<MediaDeviceInfo[]>([]);
  const [camIdx, setCamIdx] = useState(0);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let jsQR: typeof import("jsqr").default | null = null;

    const scan = () => {
      if (stopped) return;
      const v = video.current;
      if (v && ctx && jsQR && v.readyState >= 2 && v.videoWidth) {
        // Scale down for speed; QR codes on a screen stay readable at 640 px.
        const scale = Math.min(1, 640 / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
        if (hit?.data) {
          if (!accept || accept(hit.data)) {
            stopped = true;
            onResult(hit.data);
            return;
          }
          setHint(true);
        }
      }
      timer = setTimeout(scan, 160);
    };

    (async () => {
      try {
        jsQR = (await import("jsqr")).default;
        const want = cams[camIdx]?.deviceId;
        stream = await navigator.mediaDevices.getUserMedia({
          video: want ? { deviceId: { exact: want } } : { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        if (video.current) {
          video.current.srcObject = stream;
          await video.current.play().catch(() => {});
        }
        if (!cams.length) {
          const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
          if (list.length > 1) setCams(list);
        }
        scan();
      } catch (e) {
        setError(String((e as Error)?.name ?? e) === "NotAllowedError" ? t("move.camDenied") : t("move.camMissing"));
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [camIdx]);

  if (error) return <div class="notice warn">{error}</div>;
  return (
    <div class="qr-scan">
      <video ref={video} playsInline muted />
      <div class="qr-frame" aria-hidden="true"><i /><i /><i /><i /></div>
      {hint && <div class="qr-hint">{t("move.notDomus")}</div>}
      {cams.length > 1 && (
        <button class="btn sm qr-switch" onClick={() => setCamIdx((i) => (i + 1) % cams.length)}>{t("move.switchCam")}</button>
      )}
    </div>
  );
}

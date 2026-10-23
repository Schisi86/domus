// Square image cropper for server icons and avatars: drag to move, wheel or
// slider to zoom. The result is a 512×512 WebP, so pictures are never
// squeezed into the wrong aspect ratio.

import { useEffect, useRef, useState } from "preact/hooks";
import { closeDialog, openDialog, toast } from "../state/app";
import { t } from "../i18n";
import { Modal } from "./components";

const STAGE = 300;
const OUT = 512;

interface View {
  x: number;
  y: number;
  zoom: number;
}

function CropDialog({ src, round, done }: { src: string; round: boolean; done: (b: Blob | null) => void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, zoom: 1 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const big = useRef<HTMLCanvasElement>(null);
  const small = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const i = new Image();
    i.onload = () => {
      setImg(i);
      const s = base(i);
      // Start centered.
      setView({ zoom: 1, x: (STAGE - i.naturalWidth * s) / 2, y: (STAGE - i.naturalHeight * s) / 2 });
    };
    i.onerror = () => {
      toast(t("crop.loadFailed"), undefined, "error");
      done(null);
    };
    i.src = src;
  }, [src]);

  const base = (i: HTMLImageElement) => Math.max(STAGE / i.naturalWidth, STAGE / i.naturalHeight);
  const scale = img ? base(img) * view.zoom : 1;

  /** Keeps the square fully covered by the picture. */
  const clamp = (v: View): View => {
    if (!img) return v;
    const s = base(img) * v.zoom;
    const w = img.naturalWidth * s;
    const h = img.naturalHeight * s;
    return { zoom: v.zoom, x: Math.min(0, Math.max(STAGE - w, v.x)), y: Math.min(0, Math.max(STAGE - h, v.y)) };
  };

  /** Zooms around a point of the stage (cursor or center). */
  const zoomTo = (zoom: number, cx = STAGE / 2, cy = STAGE / 2) => {
    if (!img) return;
    const z = Math.max(1, Math.min(8, zoom));
    setView((v) => {
      const k = z / v.zoom;
      return clamp({ zoom: z, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k });
    });
  };

  const draw = (c: HTMLCanvasElement | null, size: number) => {
    if (!c || !img) return;
    c.width = size;
    c.height = size;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    const sw = STAGE / scale;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, -view.x / scale, -view.y / scale, sw, sw, 0, 0, size, size);
  };
  useEffect(() => {
    draw(big.current, 112);
    draw(small.current, 64);
  }, [img, view]);

  const apply = () => {
    const c = document.createElement("canvas");
    draw(c, OUT);
    c.toBlob((b) => done(b), "image/webp", 0.9);
  };

  return (
    <Modal
      layer="dialog"
      class="crop-modal"
      title={t("crop.title")}
      sub={t("crop.hint")}
      onClose={() => done(null)}
      footer={
        <>
          <button class="btn ghost" onClick={() => done(null)}>{t("common.cancel")}</button>
          <button class="btn primary" disabled={!img} onClick={apply}>{t("crop.apply")}</button>
        </>
      }
    >
      <div
        class={`crop-stage${dragging ? " dragging" : ""}`}
        style={{ width: `${STAGE}px`, height: `${STAGE}px` }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setView((v) => clamp({ ...v, x: d.x + e.clientX - d.px, y: d.y + e.clientY - d.py }));
        }}
        onPointerUp={() => {
          drag.current = null;
          setDragging(false);
        }}
        onWheel={(e) => {
          e.preventDefault();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          zoomTo(view.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - r.left, e.clientY - r.top);
        }}
      >
        {img && (
          <img
            src={src}
            alt=""
            draggable={false}
            style={{ width: `${img.naturalWidth}px`, height: `${img.naturalHeight}px`, transform: `translate(${view.x}px, ${view.y}px) scale(${scale})` }}
          />
        )}
        <div class="crop-grid" />
        <div class={`crop-frame${round ? " round" : ""}`} />
      </div>
      <div class="row" style={{ gap: "10px" }}>
        <span class="label" style={{ margin: "0px" }}>{t("crop.zoom")}</span>
        <input class="range grow" type="range" min={1} max={8} step={0.01} value={view.zoom} onInput={(e) => zoomTo(Number((e.target as HTMLInputElement).value))} />
      </div>
      <div class="crop-preview">
        <canvas ref={big} class={round ? "round" : ""} />
        <canvas ref={small} class={`small${round ? " round" : ""}`} />
        <span class="faint xs">{t("crop.preview")}</span>
      </div>
    </Modal>
  );
}

/** Lets the user crop a picture to a square; resolves to null when cancelled. */
export function cropImage(file: Blob, opts: { round?: boolean } = {}): Promise<Blob | null> {
  return new Promise((resolve) => {
    const src = URL.createObjectURL(file);
    const done = (b: Blob | null) => {
      closeDialog();
      URL.revokeObjectURL(src);
      resolve(b);
    };
    openDialog(<CropDialog src={src} round={!!opts.round} done={done} />);
  });
}

/** Opens a file picker for an image and crops it; null when cancelled. */
export function pickAndCropImage(opts: { round?: boolean } = {}): Promise<Blob | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      if (f.size > 40 * 1024 * 1024) {
        toast(t("common.imageTooLarge"), undefined, "warn");
        return resolve(null);
      }
      void cropImage(f, opts).then(resolve);
    };
    input.click();
  });
}

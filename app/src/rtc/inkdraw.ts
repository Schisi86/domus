// Drawing code for annotations on a stream: strokes that fade out and laser
// pointers with a name tag. Shared by the in-app layer over a video tile and
// the transparent overlay window on the sharer's desktop.

/** A freehand line; points are normalized (0..1) to the stream picture. */
export interface Stroke {
  /** Unique per author: `${uid}:${id}`. */
  key: string;
  from: number;
  color: string;
  /** Line width relative to the picture height. */
  width: number;
  pts: number[];
  /** When the author lifted the pen (ms); null while still drawing. */
  done: number | null;
}

export interface Pointer {
  x: number;
  y: number;
  at: number;
  color: string;
  name: string;
}

export const INK_COLORS = ["#ff3b5c", "#ffb020", "#34d27b", "#2aa8ff", "#b46bff", "#ffffff"];
/** A finished stroke stays this long, then fades out. */
export const STROKE_HOLD_MS = 7000;
export const STROKE_FADE_MS = 1200;
export const POINTER_HOLD_MS = 1400;

/** Stable colour per person for the laser pointer. */
export function userColor(uid: number) {
  return INK_COLORS[Math.abs(uid) % (INK_COLORS.length - 1)];
}

export function strokeAlpha(s: Stroke, now: number) {
  if (s.done === null) return 1;
  const age = now - s.done;
  if (age <= STROKE_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS);
}

/**
 * Paints strokes and pointers into a `w`×`h` area. Returns true while something
 * is still visible (the caller keeps animating).
 */
export function drawInk(ctx: CanvasRenderingContext2D, w: number, h: number, strokes: Iterable<Stroke>, pointers: Iterable<Pointer>, now: number): boolean {
  ctx.clearRect(0, 0, w, h);
  let alive = false;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const a = strokeAlpha(s, now);
    if (a <= 0 || s.pts.length < 2) continue;
    alive = true;
    const lw = Math.max(2, s.width * h);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(s.pts[0] * w, s.pts[1] * h);
      if (s.pts.length === 2) ctx.lineTo(s.pts[0] * w + 0.01, s.pts[1] * h);
      // Quadratic smoothing through the midpoints keeps fast strokes round.
      for (let i = 2; i < s.pts.length - 2; i += 2) {
        const mx = ((s.pts[i] + s.pts[i + 2]) / 2) * w;
        const my = ((s.pts[i + 1] + s.pts[i + 3]) / 2) * h;
        ctx.quadraticCurveTo(s.pts[i] * w, s.pts[i + 1] * h, mx, my);
      }
      if (s.pts.length >= 4) ctx.lineTo(s.pts[s.pts.length - 2] * w, s.pts[s.pts.length - 1] * h);
    };
    ctx.globalAlpha = a * 0.55;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = lw + 3;
    path();
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = lw;
    path();
    ctx.stroke();
  }
  for (const p of pointers) {
    const age = now - p.at;
    if (age > POINTER_HOLD_MS) continue;
    alive = true;
    const a = age < POINTER_HOLD_MS - 400 ? 1 : Math.max(0, (POINTER_HOLD_MS - age) / 400);
    const x = p.x * w;
    const y = p.y * h;
    const r = Math.max(6, h * 0.011);
    ctx.globalAlpha = a * 0.28;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    if (p.name) {
      const fs = Math.max(11, Math.round(h * 0.017));
      ctx.font = `600 ${fs}px system-ui, "Segoe UI", sans-serif`;
      const tw = ctx.measureText(p.name).width;
      const bx = Math.min(w - tw - 14, x + r + 6);
      const by = Math.min(h - fs - 8, y + r + 4);
      ctx.fillStyle = "rgba(10,12,18,0.82)";
      ctx.beginPath();
      ctx.roundRect(bx, by, tw + 12, fs + 8, 6);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "top";
      ctx.fillText(p.name, bx + 6, by + 4);
    }
  }
  ctx.globalAlpha = 1;
  return alive;
}

/** Removes strokes that have completely faded; returns the kept ones. */
export function pruneStrokes(list: Stroke[], now: number): Stroke[] {
  return list.filter((s) => s.done === null || now - s.done < STROKE_HOLD_MS + STROKE_FADE_MS);
}

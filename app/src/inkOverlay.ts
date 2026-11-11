// The transparent overlay window on the sharer's desktop: paints the marks and
// laser pointers the main window forwards (see rtc/ink.ts). It never takes
// input – the window is click-through and excluded from screen capture.

import { listen } from "@tauri-apps/api/event";
import { drawInk, pruneStrokes, type Pointer, type Stroke } from "./rtc/inkdraw";

const canvas = document.getElementById("ink") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
let strokes: Stroke[] = [];
const pointers = new Map<number, Pointer>();
let running = false;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

function frame() {
  const now = Date.now();
  strokes = pruneStrokes(strokes, now);
  running = drawInk(ctx, canvas.width, canvas.height, strokes, pointers.values(), now);
  if (running) requestAnimationFrame(frame);
}

function wake() {
  if (!running) {
    running = true;
    requestAnimationFrame(frame);
  }
}

window.addEventListener("resize", () => {
  resize();
  wake();
});
resize();

void listen<any>("ink", ({ payload: m }) => {
  if (m.k === "stroke") {
    let s = strokes.find((x) => x.key === m.key);
    if (!s) strokes.push((s = { key: m.key, from: 0, color: m.color, width: m.width, pts: [], done: null }));
    for (const p of m.pts as number[]) s.pts.push(p);
    if (m.end) s.done = Date.now();
  } else if (m.k === "clear") {
    strokes = m.author === null ? [] : strokes.filter((s) => !s.key.startsWith(`${m.author}:`));
  } else if (m.k === "ptr") {
    if (m.x === null || m.y === null) pointers.delete(m.from);
    else pointers.set(m.from, { x: m.x, y: m.y, at: Date.now(), color: m.color, name: m.name });
  }
  wake();
});

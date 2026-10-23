// Simplified country flags as inline SVG (Windows renders no flag emojis).
// All flags use a 30×20 view box.

import type { JSX } from "preact";

function star(cx: number, cy: number, r: number, rot = -90) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = ((rot + i * 36) * Math.PI) / 180;
    const rr = i % 2 === 0 ? r : r * 0.4;
    pts.push(`${(cx + rr * Math.cos(a)).toFixed(2)},${(cy + rr * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(" ");
}

const FLAGS: Record<string, JSX.Element> = {
  de: (
    <>
      <rect width="30" height="6.67" fill="#000" />
      <rect y="6.67" width="30" height="6.67" fill="#dd0000" />
      <rect y="13.33" width="30" height="6.67" fill="#ffce00" />
    </>
  ),
  gb: (
    <>
      <rect width="30" height="20" fill="#012169" />
      <path d="M0 0 30 20M30 0 0 20" stroke="#fff" stroke-width="4" />
      <path d="M0 0 30 20M30 0 0 20" stroke="#c8102e" stroke-width="1.6" />
      <path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6" />
      <path d="M15 0v20M0 10h30" stroke="#c8102e" stroke-width="3.4" />
    </>
  ),
  es: (
    <>
      <rect width="30" height="20" fill="#aa151b" />
      <rect y="5" width="30" height="10" fill="#f1bf00" />
      <rect x="6" y="7.5" width="3.4" height="5" rx="0.6" fill="#aa151b" opacity="0.85" />
    </>
  ),
  fr: (
    <>
      <rect width="10" height="20" fill="#002395" />
      <rect x="10" width="10" height="20" fill="#fff" />
      <rect x="20" width="10" height="20" fill="#ed2939" />
    </>
  ),
  it: (
    <>
      <rect width="10" height="20" fill="#009246" />
      <rect x="10" width="10" height="20" fill="#fff" />
      <rect x="20" width="10" height="20" fill="#ce2b37" />
    </>
  ),
  pt: (
    <>
      <rect width="30" height="20" fill="#da291c" />
      <rect width="12" height="20" fill="#046a38" />
      <circle cx="12" cy="10" r="4.4" fill="#ffe900" />
      <rect x="10.2" y="7.6" width="3.6" height="4.6" rx="1.2" fill="#da291c" stroke="#fff" stroke-width="0.6" />
    </>
  ),
  nl: (
    <>
      <rect width="30" height="6.67" fill="#ae1c28" />
      <rect y="6.67" width="30" height="6.67" fill="#fff" />
      <rect y="13.33" width="30" height="6.67" fill="#21468b" />
    </>
  ),
  pl: (
    <>
      <rect width="30" height="10" fill="#fff" />
      <rect y="10" width="30" height="10" fill="#dc143c" />
    </>
  ),
  tr: (
    <>
      <rect width="30" height="20" fill="#e30a17" />
      <circle cx="11" cy="10" r="5" fill="#fff" />
      <circle cx="12.3" cy="10" r="4" fill="#e30a17" />
      <polygon points={star(17.6, 10, 2.4, 180)} fill="#fff" />
    </>
  ),
  ru: (
    <>
      <rect width="30" height="6.67" fill="#fff" />
      <rect y="6.67" width="30" height="6.67" fill="#0039a6" />
      <rect y="13.33" width="30" height="6.67" fill="#d52b1e" />
    </>
  ),
  sa: (
    <>
      <rect width="30" height="20" fill="#006c35" />
      <path d="M7 8.2c1.2-1.2 2 .8 3.2-.4s1.6.9 2.9-.3 1.7.8 3-.4 1.6.9 3-.3 1.5.8 3.9-.4" fill="none" stroke="#fff" stroke-width="1.1" stroke-linecap="round" />
      <path d="M8 13.4h13.5l1.6-0.9" fill="none" stroke="#fff" stroke-width="0.9" stroke-linecap="round" />
    </>
  ),
  in: (
    <>
      <rect width="30" height="6.67" fill="#ff9933" />
      <rect y="6.67" width="30" height="6.67" fill="#fff" />
      <rect y="13.33" width="30" height="6.67" fill="#138808" />
      <circle cx="15" cy="10" r="2.6" fill="none" stroke="#000080" stroke-width="0.6" />
      <circle cx="15" cy="10" r="0.6" fill="#000080" />
    </>
  ),
  cn: (
    <>
      <rect width="30" height="20" fill="#ee1c25" />
      <polygon points={star(5, 5, 3)} fill="#ffff00" />
      <polygon points={star(10, 2, 1, -60)} fill="#ffff00" />
      <polygon points={star(12, 4, 1, -80)} fill="#ffff00" />
      <polygon points={star(12, 7, 1, -100)} fill="#ffff00" />
      <polygon points={star(10, 9, 1, -120)} fill="#ffff00" />
    </>
  ),
  jp: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <circle cx="15" cy="10" r="6" fill="#bc002d" />
    </>
  ),
  kr: (
    <>
      <rect width="30" height="20" fill="#fff" />
      <g transform="rotate(-33.7 15 10)">
        <path d="M10 10a5 5 0 0 1 10 0z" fill="#cd2e3a" />
        <path d="M10 10a5 5 0 0 0 10 0z" fill="#0047a0" />
        <circle cx="12.5" cy="10" r="2.5" fill="#cd2e3a" />
        <circle cx="17.5" cy="10" r="2.5" fill="#0047a0" />
      </g>
      <g stroke="#000" stroke-width="0.9">
        <path d="M4 4.2l2.4-1.6M4.6 5.1l2.4-1.6M5.2 6l2.4-1.6" />
        <path d="M22.6 2.6l2.4 1.6M23.2 3.5l2.4 1.6M23.8 4.4l2.4 1.6" />
        <path d="M4 15.8l2.4 1.6M4.6 14.9l2.4 1.6M5.2 14l2.4 1.6" />
        <path d="M22.6 17.4l2.4-1.6M23.2 16.5l2.4-1.6M23.8 15.6l2.4-1.6" />
      </g>
    </>
  ),
};

export function Flag({ code, class: cls, title }: { code: string; class?: string; title?: string }) {
  return (
    <svg viewBox="0 0 30 20" class={cls ?? "flag-inline"} role="img" aria-label={title} preserveAspectRatio="none">
      {title && <title>{title}</title>}
      {FLAGS[code] ?? <rect width="30" height="20" fill="#888" />}
    </svg>
  );
}

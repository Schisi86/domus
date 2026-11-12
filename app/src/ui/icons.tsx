// Inline SVG icons (24×24, stroke based). No icon font or library needed.

import type { JSX } from "preact";

type P = { size?: number; class?: string; title?: string };

function I(paths: JSX.Element, fill = false) {
  return ({ size = 20, class: cls = "icon", title }: P) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      class={cls}
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={title ? undefined : "true"}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {paths}
    </svg>
  );
}

export const Hash = I(<path d="M5 9h14M5 15h14M10 3 8 21M16 3l-2 18" />);
export const Speaker = I(<><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" /></>);
export const Mic = I(<><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0M12 17v5M8 22h8" /></>);
export const MicOff = I(<><path d="m2 2 20 20M9 9v1a3 3 0 0 0 5.1 2.1M15 9.3V5a3 3 0 0 0-5.9-.7" /><path d="M17 16.9A7 7 0 0 1 5 10M19 10a7 7 0 0 1-.1 1.2M12 17v5M8 22h8" /></>);
export const Headphones = I(<path d="M3 18v-6a9 9 0 0 1 18 0v6M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z" />);
export const HeadphonesOff = I(<><path d="m2 2 20 20M3 18v-6a9 9 0 0 1 2.6-6.3M8.3 3.8A9 9 0 0 1 21 12v5" /><path d="M3 19a2 2 0 0 0 2 2h1v-6H3z" /></>);
export const Screen = I(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>);
export const ScreenOff = I(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4M8 7l8 6M16 7l-8 6" /></>);
export const Camera = I(<><path d="m16 10 6-4v12l-6-4" /><rect x="2" y="6" width="14" height="12" rx="2" /></>);
export const CameraOff = I(<><path d="m2 2 20 20M16 10l6-4v12M14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" /></>);
export const Gear = I(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const Plus = I(<path d="M12 5v14M5 12h14" />);
export const X = I(<path d="M18 6 6 18M6 6l12 12" />);
export const PhoneOff = I(<><path d="M10.7 13.3a16 16 0 0 0 3.4 2.6l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.5 2.6.6A2 2 0 0 1 22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.6 2.6a2 2 0 0 1-.4 2.1L8 9.7" /><path d="m22 2-20 20" /></>);
export const Users = I(<><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>);
export const Search = I(<><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);
export const Paperclip = I(<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />);
export const Send = I(<path d="m22 2-7 20-4-9-9-4zM22 2 11 13" />);
export const Reply = I(<path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 5 5v6" />);
export const Edit = I(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />);
export const Trash = I(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />);
export const Copy = I(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const More = I(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>);
export const ChevronDown = I(<path d="m6 9 6 6 6-6" />);
export const Home = I(<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />);
export const ServerIcon = I(<><rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" /><path d="M6 7h.01M6 17h.01" /></>);
export const Shield = I(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />);
export const Logout = I(<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />);
export const Check = I(<path d="M20 6 9 17l-5-5" />);
export const Download = I(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />);
export const File = I(<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /></>);
export const Bell = I(<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" />);
export const BellOff = I(<path d="M13.7 21a2 2 0 0 1-3.4 0M18.6 13A17.9 17.9 0 0 1 18 8M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.3-5M2 2l20 20" />);
export const Lock = I(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></>);
export const UserPlus = I(<><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="8.5" cy="7" r="4" /><path d="M20 8v6M23 11h-6" /></>);
export const Crown = I(<path d="m2 18 2-11 5 5 3-7 3 7 5-5 2 11z" />);
export const Signal = I(<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16" />);
export const Maximize = I(<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />);
export const Chat = I(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const Refresh = I(<path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />);
export const Folder = I(<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />);
export const Info = I(<><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></>);
export const Heart = I(<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" />);
export const Smile = I(<><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01" /></>);
export const Pin = I(<path d="M12 17v5M9 10.8V4h6v6.8l3 3.2H6z" />);
export const Globe = I(<><circle cx="12" cy="12" r="10" /><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20" /></>);
export const Palette = I(<><circle cx="13.5" cy="6.5" r="1" /><circle cx="17.5" cy="10.5" r="1" /><circle cx="8.5" cy="7.5" r="1" /><circle cx="6.5" cy="12.5" r="1" /><path d="M12 2a10 10 0 0 0 0 20 2 2 0 0 0 2-2c0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.3a2 2 0 0 1 2-2h2.3A5.7 5.7 0 0 0 22 9.7C22 5.4 17.5 2 12 2z" /></>);
export const Keyboard = I(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M8 17h8M10 13h4" /></>);
export const ExternalLink = I(<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" />);
export const Bold = I(<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z" />);
export const Italic = I(<path d="M19 4h-9M14 20H5M15 4 9 20" />);
export const Play = I(<path d="M7 4.5v15l12-7.5z" />);
export const Stop = I(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const Link = I(<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />);
export const Sliders = I(<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />);
export const Laptop = I(<><rect x="4" y="4" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>);
export const Poll = I(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>);
export const Forward = I(<><path d="m15 5 6 6-6 6" /><path d="M21 11H9a6 6 0 0 0-6 6v2" /></>);
export const Music = I(<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>);
export const Clock = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const ChevronRight = I(<path d="m9 6 6 6-6 6" />);
export const Hammer = I(<><path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9" /><path d="m17.6 15 4.4-4.4-6.6-6.6L11 8.4z" /></>);
export const UserMinus = I(<><circle cx="9" cy="8" r="4" /><path d="M2 21a7 7 0 0 1 14 0M16 11h6" /></>);
export const Note = I(<><path d="M5 3h10l4 4v14H5z" /><path d="M9 9h6M9 13h6M9 17h4" /></>);
export const Pause = I(<><rect x="6" y="4" width="4" height="16" rx="1.2" /><rect x="14" y="4" width="4" height="16" rx="1.2" /></>);
export const Pip = I(<><rect x="2" y="4" width="20" height="16" rx="2" /><rect x="12" y="11" width="8" height="6" rx="1" /></>);
export const Inbox = I(<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>);
export const Mail = I(<><rect x="2.5" y="5" width="19" height="14" rx="2.5" /><path d="m3.5 7 8.5 6 8.5-6" /></>);
export const Webcam = I(<><circle cx="12" cy="10" r="7" /><circle cx="12" cy="10" r="2.6" /><path d="M8 20.5h8M12 17v3.5" /></>);
export const WebcamOff = I(<><circle cx="12" cy="10" r="7" /><circle cx="12" cy="10" r="2.6" /><path d="M8 20.5h8M12 17v3.5M3 3l18 18" /></>);
export const Volume = I(<><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></>);
export const VolumeOff = I(<><path d="M11 5 6 9H2v6h4l5 4z" /><path d="M22 9l-6 6M16 9l6 6" /></>);
export const Remote = I(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /><circle cx="12" cy="10" r="2.3" /></>);
export const Pen = I(<><path d="M12 19l7-7 3 3-7 7-3-3z" /><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.6 7.6" /><circle cx="11" cy="11" r="2" /></>);
export const Pointer = I(<><path d="M4 4l7.1 16.4 2.3-6.6 6.6-2.3z" /><path d="M14 14l5.5 5.5" /></>);
export const Scissors = I(<><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" /></>);
export const Film = I(<><rect x="2" y="3" width="20" height="18" rx="2.5" /><path d="M7 3v18M17 3v18M2 8h5M2 12h20M2 16h5M17 8h5M17 16h5" /></>);
export const Eye = I(<><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>);
export const EyeOff = I(<><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6A17.3 17.3 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M2 2l20 20" /></>);
export const Unlock = I(<><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 9.6-2" /></>);
export const Gamepad = I(<><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" /><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6C2.1 13.1 2 15.4 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.4-1.4a2 2 0 0 1 1.4-.6h4.4a2 2 0 0 1 1.4.6L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-.6-.1-2.9-.7-7.4a4 4 0 0 0-4-3.6z" /></>);
export const Upload = I(<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />);
export const Eraser = I(<><path d="M20 20H9L3.6 14.6a2 2 0 0 1 0-2.8l8.2-8.2a2 2 0 0 1 2.8 0l5.8 5.8a2 2 0 0 1 0 2.8L13 20" /><path d="M7.5 9.5l7 7" /></>);
export const Minimize = I(<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />);
export const Zap = I(<path d="M13 2 3 14h9l-1 8 10-12h-9z" />);
export const Phone = I(<><rect x="6" y="2" width="12" height="20" rx="2.5" /><path d="M10.5 18.5h3" /></>);
export const Qr = I(<><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>);
export const ChevronLeft = I(<path d="m15 18-6-6 6-6" />);

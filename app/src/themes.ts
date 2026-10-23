// The ten built-in designs. Colors live in styles.css; this list drives the
// picker (preview swatches use the theme's main colors).

export interface ThemeInfo {
  id: string;
  light: boolean;
  /** rail, sidebar, main, accent, accent-2 */
  swatch: [string, string, string, string, string];
  /** Background gradient for the picker preview. */
  preview: string;
}

export const THEMES: ThemeInfo[] = [
  { id: "emerald", light: false, swatch: ["#07140f", "#0b1a15", "#0f221b", "#2ee59d", "#8ff5cf"], preview: "radial-gradient(circle at 0% 0%, #2ee59d55, transparent 60%), radial-gradient(circle at 100% 100%, #14a0be55, transparent 60%), linear-gradient(155deg, #0b2c22, #051a14 45%, #07222c)" },
  { id: "jade", light: true, swatch: ["#d8ece2", "#eaf6f0", "#fbfefc", "#0e9f68", "#34d399"], preview: "radial-gradient(circle at 0% 0%, #34d39977, transparent 60%), radial-gradient(circle at 100% 100%, #7dd3fc77, transparent 60%), linear-gradient(150deg, #e3f6ec, #f7fbf2 50%, #def0f6)" },
  { id: "midnight", light: false, swatch: ["#070b18", "#0b1122", "#0f172c", "#6b97ff", "#a9c2ff"], preview: "radial-gradient(circle at 0% 0%, #6b97ff66, transparent 60%), radial-gradient(circle at 100% 100%, #9650ff66, transparent 60%), linear-gradient(160deg, #141c4c, #0b1030 45%, #1e1144)" },
  { id: "aurora", light: false, swatch: ["#0b0a1a", "#110f24", "#15132c", "#a78bfa", "#2dd4bf"], preview: "radial-gradient(circle at 8% 0%, #2dd4bf77, transparent 55%), radial-gradient(circle at 92% 15%, #a78bfa77, transparent 55%), radial-gradient(circle at 50% 115%, #ec489966, transparent 60%), linear-gradient(160deg, #0b1d30, #120f2e 50%, #1d0f2c)" },
  { id: "obsidian", light: false, swatch: ["#000000", "#070707", "#0b0b0b", "#b6f23d", "#dcff8f"], preview: "radial-gradient(circle at 100% 0%, #b6f23d33, transparent 60%), radial-gradient(circle at 0% 100%, #b6f23d22, transparent 60%), #000" },
  { id: "sakura", light: true, swatch: ["#f6dfe8", "#fcf0f5", "#fffbfd", "#e0558a", "#f78fb3"], preview: "radial-gradient(circle at 0% 0%, #f78fb388, transparent 60%), radial-gradient(circle at 100% 100%, #c4b5fd88, transparent 60%), linear-gradient(150deg, #fde3ed, #fbf0f7 50%, #ebe5fd)" },
  { id: "arctic", light: true, swatch: ["#dce8f2", "#edf4fa", "#fbfdff", "#1683e0", "#00b8d4"], preview: "radial-gradient(circle at 0% 0%, #5ec8ff88, transparent 60%), radial-gradient(circle at 100% 100%, #6ee7b777, transparent 60%), linear-gradient(150deg, #dbebfb, #f2f8ff 50%, #ddf6ef)" },
  { id: "sunset", light: false, swatch: ["#130b0d", "#1a0f13", "#201418", "#ff7a45", "#ff4d8d"], preview: "radial-gradient(circle at 100% 100%, #ff8c3288, transparent 60%), radial-gradient(circle at 0% 0%, #7828a088, transparent 60%), linear-gradient(165deg, #3a1242, #681c3e 45%, #9c3c1f)" },
  { id: "neon", light: false, swatch: ["#05050c", "#090914", "#0d0d1b", "#00e5ff", "#ff2bd6"], preview: "radial-gradient(circle at 0% 0%, #00e5ff66, transparent 58%), radial-gradient(circle at 100% 100%, #ff2bd666, transparent 58%), linear-gradient(150deg, #050a1c, #0c0a28 50%, #150622)" },
  { id: "sandstone", light: true, swatch: ["#e6dccc", "#f4ede2", "#fdfaf5", "#c0623b", "#d99b4a"], preview: "radial-gradient(circle at 0% 0%, #e7b36f88, transparent 60%), radial-gradient(circle at 100% 100%, #f4a3a388, transparent 60%), linear-gradient(150deg, #f7e5d3, #fcf3ea 50%, #f3ded7)" },
];

export function applyTheme(id: string, followSystem: boolean) {
  let theme = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (followSystem) {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = dark ? THEMES[0] : THEMES[1];
  }
  document.documentElement.dataset.theme = theme.id;
}

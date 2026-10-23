// The ten built-in designs. Colors live in styles.css; this list drives the
// picker (preview swatches use the theme's main colors).

export interface ThemeInfo {
  id: string;
  light: boolean;
  /** rail, sidebar, main, accent, accent-2 */
  swatch: [string, string, string, string, string];
}

export const THEMES: ThemeInfo[] = [
  { id: "emerald", light: false, swatch: ["#07140f", "#0b1a15", "#0f221b", "#2ee59d", "#8ff5cf"] },
  { id: "jade", light: true, swatch: ["#d8ece2", "#eaf6f0", "#fbfefc", "#0e9f68", "#34d399"] },
  { id: "midnight", light: false, swatch: ["#070b18", "#0b1122", "#0f172c", "#6b97ff", "#a9c2ff"] },
  { id: "aurora", light: false, swatch: ["#0b0a1a", "#110f24", "#15132c", "#a78bfa", "#2dd4bf"] },
  { id: "obsidian", light: false, swatch: ["#000000", "#070707", "#0b0b0b", "#b6f23d", "#dcff8f"] },
  { id: "sakura", light: true, swatch: ["#f6dfe8", "#fcf0f5", "#fffbfd", "#e0558a", "#f78fb3"] },
  { id: "arctic", light: true, swatch: ["#dce8f2", "#edf4fa", "#fbfdff", "#1683e0", "#00b8d4"] },
  { id: "sunset", light: false, swatch: ["#130b0d", "#1a0f13", "#201418", "#ff7a45", "#ff4d8d"] },
  { id: "neon", light: false, swatch: ["#05050c", "#090914", "#0d0d1b", "#00e5ff", "#ff2bd6"] },
  { id: "sandstone", light: true, swatch: ["#e6dccc", "#f4ede2", "#fdfaf5", "#c0623b", "#d99b4a"] },
];

export function applyTheme(id: string, followSystem: boolean) {
  let theme = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (followSystem) {
    const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    theme = dark ? THEMES[0] : THEMES[1];
  }
  document.documentElement.dataset.theme = theme.id;
}

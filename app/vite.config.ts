import { defineConfig } from "vite";

// Preact with the automatic JSX runtime; no framework plugin needed.
export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: {
    target: "es2022",
    cssCodeSplit: false,
    sourcemap: false,
    chunkSizeWarningLimit: 400,
  },
});

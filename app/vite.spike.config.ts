import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/*
 * H01 browser spike server. Isolated: serves only `spike.html`, never imported by the app build
 * (`vite build` uses the default config). Same plugins and alias as the app so the production
 * wrappers under test resolve identically; no `/api` proxy — the spike mounts components, not
 * the app shell.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    host: "::",
    port: 5199,
    strictPort: true,
  },
});

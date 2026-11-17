import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Extra host names the dev server answers to (comma-separated), from the root .env.
  const env = loadEnv(mode, "../..", "BURROW_");
  const extraHosts = (env.BURROW_DEV_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  // The API to proxy to (another port for a throwaway test server).
  const api = process.env.BURROW_DEV_API || "http://localhost:4100";
  return {
    plugins: [react()],
    server: {
      port: 5180,
      strictPort: true,
      allowedHosts: ["fedora", ...extraHosts],
      host: true,
      // Keep the browser's Host header: the server compares it with Origin (same-origin writes,
      // passkey relying party; D-032). The string shorthand would rewrite it to localhost:4100.
      proxy: {
        // ws: the web terminal's WebSocket (/api/tui, D-037).
        "/api": { target: api, changeOrigin: false, ws: true },
        "/media": { target: api, changeOrigin: false },
      },
    },
  };
});

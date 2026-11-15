import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // Extra host names the dev server answers to (comma-separated), from the root .env.
  const env = loadEnv(mode, "../..", "BURROW_");
  const extraHosts = (env.BURROW_DEV_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
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
        "/api": { target: "http://localhost:4100", changeOrigin: false },
        "/media": { target: "http://localhost:4100", changeOrigin: false },
      },
    },
  };
});

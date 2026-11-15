import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    allowedHosts: ["fedora", "fedora.example.com"],
    host: true,
    // Keep the browser's Host header: the server compares it with Origin (same-origin writes,
    // passkey relying party; D-032). The string shorthand would rewrite it to localhost:4100.
    proxy: {
      "/api": { target: "http://localhost:4100", changeOrigin: false },
      "/media": { target: "http://localhost:4100", changeOrigin: false },
    },
  },
});

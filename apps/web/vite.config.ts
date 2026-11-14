import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    allowedHosts: ["fedora", "fedora.example.com"],
    host: true,
    proxy: { "/api": "http://localhost:4100", "/media": "http://localhost:4100" },
  },
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// axe:webui — web interface served by the session service (`--listen`).
// Built into web/dist and embedded in the binary (crates/axecode-daemon/src/webui).
const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root,
  base: "/",
  plugins: [react()],
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 1430,
    proxy: {
      "/api": "http://127.0.0.1:9119",
      "/ws": { target: "ws://127.0.0.1:9119", ws: true },
    },
  },
});

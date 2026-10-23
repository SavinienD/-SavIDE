// Configuration Vite du banc d'affichage : la racine est celle du depot, pour
// servir la VRAIE interface (src/) ; seule l'entree change (banc.html).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ici = dirname(fileURLToPath(import.meta.url));
const racine = resolve(ici, "../..");
// Interface rendue : src/ du dépôt, ou celle d'une autre version extraite par le
// lanceur (--source <révision>, variable AXECODE_AUDIT_SOURCE).
const source = resolve(process.env.AXECODE_AUDIT_SOURCE ?? racine);
const sortieBuild = resolve(process.env.AXECODE_AUDIT_BUILD ?? resolve(ici, "sortie/build"));

export default defineConfig({
  root: racine,
  base: "/",
  configFile: false,
  // Cache de Vite dans la sortie du banc : jamais dans le node_modules partagé du dépôt.
  cacheDir: resolve(ici, "sortie/.vite"),
  resolve: { alias: [{ find: /^@axecode-src\//, replacement: resolve(source, "src") + "/" }] },
  plugins: [react()],
  clearScreen: false,
  logLevel: "warn",
  server: { host: "127.0.0.1", hmr: false, watch: null, fs: { allow: [racine] } },
  optimizeDeps: { entries: ["scripts/audit-affichage/banc.html"] },
  build: {
    outDir: sortieBuild,
    emptyOutDir: true,
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    reportCompressedSize: false,
    chunkSizeWarningLimit: 20000,
    rollupOptions: { input: resolve(ici, "banc.html") },
  },
});

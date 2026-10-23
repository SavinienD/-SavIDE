import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// axe:viewers — pdf.js side assets (CMaps, standard fonts, wasm decoders)
// served under /pdfjs/ in dev and copied into dist at build time. They are
// only fetched by the PDF viewer, never part of the startup bundle.
const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];
function pdfjsAssets(): Plugin {
  const root = join(process.cwd(), "node_modules", "pdfjs-dist");
  return {
    name: "axe-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const [dir, file] = rel.split("/");
        const path = join(root, dir ?? "", file ?? "");
        if (!PDFJS_ASSET_DIRS.includes(dir) || !file || !existsSync(path)) return next();
        if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
        res.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        const full = join(root, dir);
        if (!existsSync(full)) continue;
        for (const file of readdirSync(full)) {
          if (file.startsWith("LICENSE")) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${file}`,
            source: readFileSync(join(full, file)),
          });
        }
      }
    },
  };
}
// axe:viewers end

// Tauri dev server config
const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), pdfjsAssets() /* axe:viewers */],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target: "es2022",
    minify: "esbuild",
    sourcemap: false,
    // Monaco editor sits around 3.8 MB by itself; raise the limit so the
    // bundler warning only fires for genuinely unexpected growth.
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (id.includes("monaco-editor") || id.includes("@monaco-editor")) {
            return "monaco";
          }
          if (id.includes("@xterm/")) return "xterm";
          if (id.includes("mermaid") || id.includes("@mermaid-js")) {
            return "mermaid";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("highlight.js")
          ) {
            return "markdown";
          }
          if (id.includes("@iconify") || id.includes("lucide-react")) {
            return "icons";
          }
        },
      },
    },
  },
}));

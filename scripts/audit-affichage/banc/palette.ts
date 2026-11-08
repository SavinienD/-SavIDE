// Lot palette — simulations du banc d'affichage : Ctrl+P (palette_fichiers). Les autres
// commandes du lot (Ctrl+K, explorateur, éditeurs) s'ajoutent ici.
/* eslint-disable @typescript-eslint/no-explicit-any */

const FICHIERS = [
  "Cargo.toml", "package.json", "README.md", "RAPPORT-AXECODE.md",
  "un-nom-de-fichier-vraiment-tres-long-pour-voir-le-debordement.md",
  "crates/axecode-app/src/repl/runtime.rs", "crates/axecode-app/src/workspace.rs",
  "docs/palette.md", "scripts/audit-affichage/lancer.mjs", "scripts/audit-affichage/scenes.mjs",
  "src/Workspace.tsx", "src/ChatPane.tsx", "src/stream.ts", "src/colonnes.ts", "src/fileAttente.ts",
  "src/styles-de-la-barre-de-titre-tres-longues.css",
  ...Array.from({ length: 40 }, (_, i) => `src/banc/etape-${i + 1}.ts`),
  "src-tauri/src/lib.rs", "src-tauri/src/palette.rs", "tests/paletteFichiers.test.cjs",
  "web/src/App.tsx", ".github/workflows/release.yml", ".gitignore",
].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

export function simulationPalette(scene: Record<string, unknown>): Record<string, (a: any, brut: any) => unknown> {
  return {
    palette_fichiers: () => ({ fichiers: FICHIERS, tronque: !!scene.paletteTronque, source: "rg" }),
  };
}

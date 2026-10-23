// Banc d'affichage d'Axecode : point d'entree.
// 1. lit la scene demandee par le lanceur (window.__BANC_SCENE__) ;
// 2. prepare le stockage local (dossiers recents, colonnes, file d'attente…) ;
// 3. installe la simulation Tauri (IPC, fenetres, evenements) AVANT tout module de l'appli ;
// 4. charge la vraie interface (src/main.tsx), sans aucune modification.
import "@fontsource/geist/300.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/600.css";
import { installerSimulation, lireScene } from "./simulation";
import { WS, NOM_WS, T0 } from "./donnees";

const scene = lireScene();
try {
  window.localStorage.clear();
  window.localStorage.setItem(
    "axecode.recentWorkspaces",
    JSON.stringify([
      { path: WS, name: NOM_WS, lastOpenedMs: T0 },
      { path: "C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin", name: "cabinet-martin", lastOpenedMs: T0 - 86_400_000 },
    ]),
  );
  const stockage = (scene.stockage ?? {}) as Record<string, unknown>;
  for (const [cle, valeur] of Object.entries(stockage)) {
    window.localStorage.setItem(cle, typeof valeur === "string" ? valeur : JSON.stringify(valeur));
  }
} catch {
  /* stockage indisponible : la scene reste utilisable */
}
installerSimulation(scene);
// src/ du dépôt, ou d'une autre version (lanceur --source) : alias de vite.config.mjs.
await import("@axecode-src/main.tsx");

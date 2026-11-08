// Lot palette — simulations du banc d'affichage : Ctrl+P (palette_fichiers), Ctrl+K
// (conversations de tous les dossiers, recherche dans leur texte). Les autres commandes du
// lot (explorateur, éditeurs) s'ajoutent ici.
/* eslint-disable @typescript-eslint/no-explicit-any */
import * as D from "./donnees";

const RACINE_LIBRE = "C:\\Users\\utilisateur\\AppData\\Local\\savide\\data\\libre";
const MARTIN = "C:\\Users\\utilisateur\\Documents\\Clients\\cabinet-martin";

const FICHIERS = [
  "Cargo.toml", "package.json", "README.md", "RAPPORT.md",
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
    palette_conversations: () => ({
      racineLibre: RACINE_LIBRE,
      conversations: [
        ...D.conversations(12).map((c) => ({ id: c.id, dossier: D.WS, titre: c.title, majMs: c.updatedAtMs })),
        { id: "m-001", dossier: MARTIN, titre: "Postes du cabinet Martin : import FIC", majMs: D.T0 - 5_000_000 },
        { id: "l-001", dossier: RACINE_LIBRE, titre: "Question rapide sur une facture", majMs: D.T0 - 7_000_000 },
      ].sort((a, b) => b.majMs - a.majMs),
    }),
    // Recherche dans le texte : deux conversations dont l'extrait contient le mot tapé.
    palette_recherche_conversations: (a: any) => {
      const q = String(a?.requete ?? "").trim();
      const base = { conversations: 14, relues: q ? 0 : 14, dureeMs: 4, tronque: false };
      if (!q) return { ...base, resultats: [] };
      return {
        ...base,
        resultats: [
          { conversationId: "c-001", dossier: D.WS, titre: D.titreDe("c-001"), majMs: D.T0, role: "assistant", messages: 4,
            extrait: `… Je relance le ${q} sur les quatre largeurs et les trois mises à l'échelle, puis je compare les captures avec celles de la veille …` },
          { conversationId: "m-001", dossier: MARTIN, titre: "Postes du cabinet Martin : import FIC", majMs: D.T0 - 5_000_000, role: "user", messages: 1,
            extrait: `Peux-tu vérifier le ${q} du cabinet avant l'import ?` },
        ],
      };
    },
    // Lot palette (P4) — couleurs git de l'explorateur et recherche limitée à un dossier.
    explorateur_git: () => ({
      depot: true,
      fichiers: [
        { chemin: "src/Workspace.tsx", etat: "modifie" },
        { chemin: "src/stream.ts", etat: "nouveau" },
        { chemin: "src/colonnes.ts", etat: "conflit" },
        { chemin: "README.md", etat: "modifie" },
        { chemin: "scripts/", etat: "nouveau" },
        { chemin: "web/", etat: "ignore" },
      ],
    }),
    palette_recherche_dossier: (a: any) => {
      const dossier = String(a?.dossier ?? "");
      const q = String(a?.query ?? "");
      const ligne = (n: number, texte: string) => ({ lineNumber: n, columnStart: 7, columnEnd: 7 + q.length, lineText: texte, matchStart: 6, matchEnd: 6 + q.length });
      return {
        query: q,
        filesScanned: 6,
        totalMatches: 2,
        files: [
          { name: "Workspace.tsx", relativePath: `${dossier}/Workspace.tsx`, absolutePath: `${D.WS}\\${dossier}\\Workspace.tsx`, pathMatch: false, matchCount: 1,
            matches: [ligne(12, `const ${q} = ouvrirPalette(espace);`)] },
          { name: "stream.ts", relativePath: `${dossier}/stream.ts`, absolutePath: `${D.WS}\\${dossier}\\stream.ts`, pathMatch: false, matchCount: 1,
            matches: [ligne(40, `export ${q} lireFlux();`)] },
        ],
      };
    },
    // Lot palette (P5) — éditeurs trouvés sur le poste, journaux, relance en administrateur.
    editeurs_detectes: () => (scene.sansEditeur ? [] : [
      { id: "vscode", nom: "VS Code", dossier: true },
      { id: "cursor", nom: "Cursor", dossier: true },
      { id: "zed", nom: "Zed", dossier: true },
    ]),
    ouvrir_dans_editeur: () => null,
    ouvrir_dossier_journaux: () => "C:\\Users\\utilisateur\\AppData\\Local\\savide\\savide\\data\\logs",
    relancer_administrateur: () => null,
  };
}

// Banc d'affichage : simulation de la revue des changements (src-tauri/src/diff.rs
// et conflits.rs). Scène « revue » : "simple" (fichiers modifiés), "vide", "conflit".
/* eslint-disable @typescript-eslint/no-explicit-any */

const AVANT = [
  "// Titres des conversations : tronqués proprement pour la barre et les onglets.",
  "export const LONGUEUR_MAX = 80;",
  "",
  "export function titreCourt(titre: string): string {",
  "  const propre = titre.trim();",
  "  if (propre.length <= LONGUEUR_MAX) return propre;",
  "  return propre.slice(0, LONGUEUR_MAX) + \"...\";",
  "}",
  "",
  "export function titreParDefaut(): string {",
  "  return \"Nouvelle conversation\";",
  "}",
  "",
  ...Array.from({ length: 24 }, (_, i) => `export const ETAPE_${i + 1} = ${i + 1};`),
  "",
  "export function compterMots(texte: string): number {",
  "  return texte.split(\" \").length;",
  "}",
  "",
].join("\n");

const APRES = [
  "// Titres des conversations : tronqués proprement pour la barre et les onglets.",
  "export const LONGUEUR_MAX = 72;",
  "",
  "export function titreCourt(titre: string, max = LONGUEUR_MAX): string {",
  "  const propre = titre.replace(/\\s+/g, \" \").trim();",
  "  if (propre.length <= max) return propre;",
  "  return `${propre.slice(0, max - 1).trimEnd()}…`;",
  "}",
  "",
  "export function titreParDefaut(): string {",
  "  return \"Nouvelle conversation\";",
  "}",
  "",
  ...Array.from({ length: 24 }, (_, i) => `export const ETAPE_${i + 1} = ${i + 1};`),
  "",
  "export function compterMots(texte: string): number {",
  "  return texte.split(/\\s+/).filter(Boolean).length;",
  "}",
  "",
  "export function estVide(titre: string | null | undefined): boolean {",
  "  return !titre || !titre.trim();",
  "}",
  "",
].join("\n");

const GUIDE = "# Guide de la revue\n\nChoisir des lignes dans le diff, puis « Noter ».\n";

export const NOTES_REVUE = (ws: string) => ({
  [`revue:notes:${ws}`]: [
    { id: "n1", fichier: "src/lib/titres.ts", debut: 4, fin: 7, cote: "nouveau", extrait: "export function titreCourt(titre: string, max = LONGUEUR_MAX): string {", texte: "Garde 80 caractères : la barre de titre en a besoin à 1920 px.", creeLe: 1 },
    { id: "n2", fichier: "src/lib/titres.ts", debut: 34, fin: 36, cote: "nouveau", extrait: "export function estVide(titre: string | null | undefined): boolean {", texte: "Ajoute un test pour estVide avec une chaîne d'espaces insécables, et vérifie que titreCourt ne coupe jamais au milieu d'un mot accentué.", creeLe: 2 },
  ],
});

export function simulationRevue(scene: any): Record<string, (a: any) => unknown> {
  if (!scene.revue) return {};
  const fichiers =
    scene.revue === "vide"
      ? []
      : [
          ...(scene.revue === "conflit" ? [{ chemin: "src/components/GitPanel.tsx", groupe: "conflit", statut: "U", ajouts: 4, suppressions: 2, binaire: false }] : []),
          { chemin: "src/lib/titres.ts", groupe: "non-indexe", statut: "M", ajouts: 9, suppressions: 5, binaire: false },
          { chemin: "docs/guide-de-la-revue-des-changements-par-l-agent.md", groupe: "non-indexe", statut: "?", ajouts: 3, suppressions: 0, binaire: false },
          { chemin: "src-tauri/icons/icon.png", groupe: "non-indexe", statut: "M", ajouts: null, suppressions: null, binaire: true },
          { chemin: "src/types.ts", groupe: "indexe", statut: "M", ajouts: 2, suppressions: 0, binaire: false },
        ];
  return {
    revue_liste: (a: any) => {
      const base = a?.input?.base ?? a?.base ?? null;
      return {
        branche: "feature/revue",
        base: base ?? "HEAD",
        baseCommit: base ? "f7e406f2b1" : null,
        branchePrincipale: "main",
        branches: ["main", "feature/revue", "origin/main"],
        fichiers: base ? fichiers.filter((f) => f.groupe !== "conflit").map((f) => ({ ...f, groupe: "base" })) : fichiers,
        operation: scene.revue === "conflit" ? "fusion" : null,
        conflits: scene.revue === "conflit" ? 1 : 0,
      };
    },
    revue_diff: (a: any) => {
      const p = a?.input ?? a ?? {};
      const md = String(p.chemin ?? "").endsWith(".md");
      const binaire = String(p.chemin ?? "").endsWith(".png");
      return {
        chemin: p.chemin,
        groupe: p.groupe,
        ancien: binaire ? null : md ? null : AVANT,
        nouveau: binaire ? null : md ? GUIDE : APRES,
        binaire,
        tropGros: false,
        nonSuivi: md,
        empreinte: "e-banc",
      };
    },
    revue_appliquer: (a: any) => ((a?.input?.lignes ?? a?.lignes) ? "Lignes indexées." : "Fichier indexé."),
  };
}

const NOUS = ["import { useState } from \"react\";", "", "export function GitPanel() {", "  const [ouvert, setOuvert] = useState(false);", "  return <div className=\"git-panel\" data-ouvert={ouvert} />;", "}", ""].join("\n");
const EUX = ["import { useEffect, useState } from \"react\";", "", "export function GitPanel() {", "  const [ouvert, setOuvert] = useState(true);", "  useEffect(() => setOuvert(true), []);", "  return <div className=\"git-panel git-panel--revue\" />;", "}", ""].join("\n");
const RESULTAT = [
  "<<<<<<< feature/revue",
  "import { useState } from \"react\";",
  "=======",
  "import { useEffect, useState } from \"react\";",
  ">>>>>>> feature/git",
  "",
  "export function GitPanel() {",
  "<<<<<<< feature/revue",
  "  const [ouvert, setOuvert] = useState(false);",
  "  return <div className=\"git-panel\" data-ouvert={ouvert} />;",
  "=======",
  "  const [ouvert, setOuvert] = useState(true);",
  "  useEffect(() => setOuvert(true), []);",
  "  return <div className=\"git-panel git-panel--revue\" />;",
  ">>>>>>> feature/git",
  "}",
  "",
].join("\n");

/** Conflits simulés (scène revue: "conflit"). */
export function simulationConflits(scene: any): Record<string, (a: any) => unknown> {
  if (scene.revue !== "conflit") return {};
  let fichiers = [
    { chemin: "src/components/GitPanel.tsx", code: "UU" },
    { chemin: "docs/notes-de-version.md", code: "UD" },
  ];
  return {
    revue_conflits: () => ({ operation: "fusion", nous: "feature/revue", eux: "feature/git", fichiers }),
    revue_conflit_fichier: (a: any) => {
      const chemin = a?.input?.chemin ?? a?.chemin;
      if (chemin === "docs/notes-de-version.md") {
        return { chemin, base: "# Notes\n", nous: "# Notes\n\n- Revue des changements\n", eux: null, resultat: "# Notes\n\n- Revue des changements\n", binaire: false };
      }
      return { chemin, base: NOUS, nous: NOUS, eux: EUX, resultat: RESULTAT, binaire: false };
    },
    revue_conflit_resoudre: (a: any) => {
      const p = a?.input ?? a ?? {};
      if (p.marquer) fichiers = fichiers.filter((f) => f.chemin !== p.chemin);
      return p.marquer ? "Fichier marqué résolu." : "Résultat enregistré.";
    },
    revue_conflits_action: (a: any) => ((a?.input?.action ?? a?.action) === "abandonner" ? "Fusion abandonnée : le dépôt est revenu à l'état d'avant." : "Fusion terminée."),
  };
}

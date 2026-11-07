// Dossiers locaux renommés ou déplacés sur le poste : retrouvés et rouverts.
// Le chemin est mis à jour partout côté page (dossiers récents et leur numéro Ctrl+1…9,
// dernier dossier ouvert, onglets et colonnes de conversations, terminaux) ; le côté Rust
// (`dossier_deplacer`) s'occupe des conversations, des sessions du service et des données
// internes du projet.
import { invoke } from "@tauri-apps/api/core";
import type { WorkspaceBootstrap } from "../types";
import { loadRecents } from "./recents";

const RECENTS_KEY = "axecode.recentWorkspaces";
const LAST_KEY = "axecode.lastWorkspace";

export type Recherche = { statut: "existe" | "retrouve" | "introuvable"; chemin?: string | null };
export type InfoDossier = { path: string; name: string };

export type Dependances = {
  ouvrir: (chemin: string) => Promise<WorkspaceBootstrap>;
  retrouver: (chemin: string, racines: string[]) => Promise<Recherche>;
  deplacer: (ancien: string, nouveau: string) => Promise<InfoDossier>;
};

export type Ouverture =
  | { kind: "ouvert"; bootstrap: WorkspaceBootstrap; deplaceDe?: string }
  | { kind: "introuvable"; chemin: string }
  | { kind: "erreur"; message: string };

/** Commandes Rust réelles. */
export const dependancesTauri: Dependances = {
  ouvrir: (chemin) => invoke<WorkspaceBootstrap>("open_workspace", { input: { workspacePath: chemin } }),
  retrouver: (chemin, racines) => invoke<Recherche>("dossier_retrouver", { input: { chemin, racines } }),
  deplacer: (ancien, nouveau) => invoke<InfoDossier>("dossier_deplacer", { input: { ancien, nouveau } }),
};

/** Au démarrage : le côté Rust note l'identité des dossiers récents qui n'en ont pas encore
 *  (ouverts avant cette version), pour pouvoir les retrouver s'ils sont déplacés plus tard. */
export function noterDossiersRecents(): void {
  const chemins = loadRecents().map((r) => r.path).filter((p) => !p.startsWith("axe-cloud://"));
  if (chemins.length === 0) return;
  void invoke("dossiers_noter", { input: { chemins } }).catch(() => undefined);
}

/** Parent d'un chemin (séparateurs / ou \), sans le dernier segment. */
export function parentDe(chemin: string): string | null {
  const net = chemin.replace(/[\\/]+$/, "");
  const i = Math.max(net.lastIndexOf("/"), net.lastIndexOf("\\"));
  return i > 0 ? net.slice(0, i) : null;
}

export function nomDe(chemin: string): string {
  const net = chemin.replace(/[\\/]+$/, "");
  const i = Math.max(net.lastIndexOf("/"), net.lastIndexOf("\\"));
  return i >= 0 ? net.slice(i + 1) || net : net;
}

/** Récents : l'entrée de `ancien` prend le nouveau chemin à la même place (même numéro
 *  Ctrl+n) ; une autre entrée déjà au nouveau chemin est retirée (pas de doublon). */
export function remplacerCheminRecent(ancien: string, nouveau: string, nom?: string): void {
  const liste = loadRecents();
  const i = liste.findIndex((r) => r.path === ancien);
  if (i < 0) return;
  const suite = liste
    .map((r, j) => (j === i ? { ...r, path: nouveau, name: nom || nomDe(nouveau) } : r))
    .filter((r, j) => j === i || r.path !== nouveau);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(suite));
  } catch {
    // quota : ignoré
  }
}

/** Remplace `ancien` par `nouveau` dans un texte, sous sa forme brute et sous sa forme JSON
 *  (barres obliques inverses doublées sous Windows). */
function remplacerChemin(texte: string, ancien: string, nouveau: string): string {
  const jsonA = JSON.stringify(ancien).slice(1, -1);
  const jsonN = JSON.stringify(nouveau).slice(1, -1);
  let sortie = texte;
  if (jsonA !== ancien) sortie = sortie.split(jsonA).join(jsonN);
  return sortie.split(ancien).join(nouveau);
}

/** Clés du stockage local rattachées au dossier : `préfixe:<chemin>` ou `préfixe:<chemin>:<suite>`. */
function cleDuDossier(cle: string, ancien: string): boolean {
  const i = cle.indexOf(":" + ancien);
  if (i < 0) return false;
  const apres = cle.slice(i + 1 + ancien.length);
  return apres === "" || apres.startsWith(":");
}

/** Stockage local de la page : dernier dossier, onglets/colonnes de conversations, terminaux… */
export function migrerStockageDossier(ancien: string, nouveau: string): void {
  if (!ancien || ancien === nouveau) return;
  try {
    if (localStorage.getItem(LAST_KEY) === ancien) localStorage.setItem(LAST_KEY, nouveau);
    const cles: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const c = localStorage.key(i);
      if (c && cleDuDossier(c, ancien)) cles.push(c);
    }
    for (const cle of cles) {
      const valeur = localStorage.getItem(cle);
      const cible = cle.replace(":" + ancien, ":" + nouveau);
      if (valeur !== null && localStorage.getItem(cible) === null) {
        localStorage.setItem(cible, remplacerChemin(valeur, ancien, nouveau));
      }
      localStorage.removeItem(cle);
    }
  } catch {
    // stockage indisponible : rien à migrer
  }
}

/** Points de départ supplémentaires : parents des autres dossiers récents. */
export function racinesRecentes(saufChemin: string): string[] {
  const vus = new Set<string>();
  for (const r of loadRecents()) {
    if (r.path === saufChemin || r.path.startsWith("axe-cloud://")) continue;
    const p = parentDe(r.path);
    if (p) vus.add(p);
  }
  return [...vus].slice(0, 12);
}

/** Côté Rust puis côté page : le dossier `ancien` se trouve désormais à `nouveau`. */
async function appliquerDeplacement(ancien: string, nouveau: string, deps: Dependances): Promise<InfoDossier> {
  const info = await deps.deplacer(ancien, nouveau);
  remplacerCheminRecent(ancien, info.path, info.name);
  migrerStockageDossier(ancien, info.path);
  return info;
}

/** Ouvre un dossier ; s'il a été renommé ou déplacé, le retrouve, met son chemin à jour
 *  partout puis l'ouvre. Ne lève jamais : « introuvable » ou « erreur » à afficher. */
export async function ouvrirDossier(chemin: string, deps: Dependances = dependancesTauri): Promise<Ouverture> {
  try {
    return { kind: "ouvert", bootstrap: await deps.ouvrir(chemin) };
  } catch (erreur) {
    if (chemin.startsWith("axe-cloud://")) return { kind: "erreur", message: String(erreur) };
    let recherche: Recherche;
    try {
      recherche = await deps.retrouver(chemin, racinesRecentes(chemin));
    } catch {
      return { kind: "introuvable", chemin };
    }
    if (recherche.statut === "existe") return { kind: "erreur", message: String(erreur) };
    if (recherche.statut !== "retrouve" || !recherche.chemin) return { kind: "introuvable", chemin };
    try {
      const info = await appliquerDeplacement(chemin, recherche.chemin, deps);
      return { kind: "ouvert", bootstrap: await deps.ouvrir(info.path), deplaceDe: chemin };
    } catch (e) {
      return { kind: "erreur", message: String(e) };
    }
  }
}

/** « Choisir le nouvel emplacement » : même mise à jour partout, puis ouverture. */
export async function deplacerEtOuvrir(ancien: string, nouveau: string, deps: Dependances = dependancesTauri): Promise<Ouverture> {
  try {
    const info = await appliquerDeplacement(ancien, nouveau, deps);
    return { kind: "ouvert", bootstrap: await deps.ouvrir(info.path), deplaceDe: ancien };
  } catch (e) {
    return { kind: "erreur", message: String(e) };
  }
}

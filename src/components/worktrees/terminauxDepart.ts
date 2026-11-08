// Worktrees — terminaux ouverts avec un nouveau worktree (worktrees.toml,
// [[terminaux]]). Les onglets sont préparés dans le stockage du panneau des
// terminaux (même format que TerminalPanel.tsx) ; la commande de chaque onglet
// part une seule fois, quand son shell démarre (prendreCommandeDepart).
import type { TerminalDefaut } from "./worktreesApi";

type Stockage = {
  getItem(cle: string): string | null;
  setItem(cle: string, valeur: string): void;
  removeItem(cle: string): void;
};

/** Clés du panneau des terminaux (TerminalPanel.tsx). */
export const cleOnglets = (dossier: string) => `axecode:terminals:${dossier}`;
const cleHistorique = (dossier: string, session: string) => `axecode:terminal-buffer:${dossier}:${session}`;
const cleCommandes = (dossier: string) => `worktrees:commandes-depart:${dossier}`;

function stockageParDefaut(): Stockage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Prépare les onglets du dossier (un « Terminal 1 » s'il n'y a rien de configuré). */
export function preparerTerminaux(dossier: string, terminaux: TerminalDefaut[], s: Stockage | null = stockageParDefaut()): void {
  if (!s) return;
  const liste = terminaux.length ? terminaux.slice(0, 10) : [{ nom: "Terminal 1", commande: null }];
  try {
    const onglets = liste.map((t, i) => ({
      index: i + 1,
      title: `Terminal ${i + 1}`,
      customTitle: t.nom && t.nom !== `Terminal ${i + 1}` ? t.nom : undefined,
      shell: "powershell",
    }));
    s.setItem(cleOnglets(dossier), JSON.stringify(onglets));
    const commandes: Record<string, string> = {};
    liste.forEach((t, i) => {
      s.removeItem(cleHistorique(dossier, `terminal-${i + 1}`));
      if (t.commande) commandes[`terminal-${i + 1}`] = t.commande;
    });
    if (Object.keys(commandes).length) s.setItem(cleCommandes(dossier), JSON.stringify(commandes));
    else s.removeItem(cleCommandes(dossier));
  } catch {
    // stockage indisponible : terminal par défaut
  }
}

/** Commande à lancer au démarrage de cet onglet (une seule fois), sinon null. */
export function prendreCommandeDepart(dossier: string, session: string, s: Stockage | null = stockageParDefaut()): string | null {
  if (!s) return null;
  try {
    const brut = s.getItem(cleCommandes(dossier));
    if (!brut) return null;
    const commandes = JSON.parse(brut) as Record<string, string>;
    const commande = commandes[session];
    if (typeof commande !== "string" || !commande.trim()) return null;
    delete commandes[session];
    if (Object.keys(commandes).length) s.setItem(cleCommandes(dossier), JSON.stringify(commandes));
    else s.removeItem(cleCommandes(dossier));
    return commande;
  } catch {
    return null;
  }
}

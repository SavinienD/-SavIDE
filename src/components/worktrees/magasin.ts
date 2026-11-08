// Worktrees — tâches de fond (création, suppression) suivies dans toute la
// fenêtre : l'état vit ici, hors des composants (il survit aux changements de
// dossier et au retour à l'accueil). Le backend publie chaque changement.
import { listen } from "@tauri-apps/api/event";
import { EVENEMENT_TACHE, worktreesApi, type TacheWorktree } from "./worktreesApi";

type Ecouteur = (tache: TacheWorktree, avant: TacheWorktree | undefined) => void;

const taches = new Map<string, TacheWorktree>();
let instantane: TacheWorktree[] = [];
const abonnes = new Set<() => void>();
const ecouteurs = new Set<Ecouteur>();
/** Tâches lancées depuis cette fenêtre : elle seule ouvre le worktree créé. */
const lanceesIci = new Set<string>();
let installe = false;

function publier(): void {
  instantane = [...taches.values()].sort((a, b) => a.debutMs - b.debutMs);
  for (const f of [...abonnes]) f();
}

/** Écoute le backend (une fois par fenêtre) et relit les tâches en cours. */
export function installerMagasin(): void {
  if (installe) return;
  installe = true;
  void listen<TacheWorktree>(EVENEMENT_TACHE, (e) => mettre(e.payload)).catch(() => undefined);
  void worktreesApi
    .taches()
    .then((liste) => {
      for (const t of liste ?? []) {
        const avant = taches.get(t.id);
        if (!avant || avant.majMs <= t.majMs) taches.set(t.id, t);
      }
      publier();
    })
    .catch(() => undefined);
}

export function mettre(tache: TacheWorktree): void {
  const avant = taches.get(tache.id);
  if (avant && avant.majMs > tache.majMs) return;
  taches.set(tache.id, tache);
  publier();
  for (const f of [...ecouteurs]) f(tache, avant);
}

export function retirer(id: string): void {
  if (taches.delete(id)) publier();
}

export function abonner(f: () => void): () => void {
  abonnes.add(f);
  return () => abonnes.delete(f);
}

export function instantaneTaches(): TacheWorktree[] {
  return instantane;
}

export function surChangement(f: Ecouteur): () => void {
  ecouteurs.add(f);
  return () => ecouteurs.delete(f);
}

export function noterLanceeIci(id: string): void {
  lanceesIci.add(id);
}

export function lanceeIci(id: string): boolean {
  return lanceesIci.has(id);
}

/** Tâche en cours sur ce dossier (pour l'état d'une ligne de la liste). */
export function tacheDuDossier(dossier: string, egal: (a: string, b: string) => boolean): TacheWorktree | undefined {
  return [...instantane].reverse().find((t) => egal(t.dossier, dossier));
}

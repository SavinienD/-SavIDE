// mémoire : la colonne de conversation gardait la vue (blocs, sorties d'outils,
// images en base64) de CHAQUE conversation ouverte, sans limite : après une longue journée,
// des dizaines de conversations restaient en mémoire. Une vue gardée ne sert qu'à une
// conversation dont le tour tourne (on y revient sans perdre le direct) ; les autres sont
// reconstruites depuis l'historique au retour. On garde donc au plus VUES_GARDEES vues
// récentes en plus de la conversation affichée, et toujours celles qui sont en cours.

export const VUES_GARDEES = 4;

/** La conversation affichée devient la plus récente (ordre d'insertion de la Map). */
export function toucherVue<T>(vues: Map<string, T>, id: string): void {
  if (!vues.has(id)) return;
  const v = vues.get(id) as T;
  vues.delete(id);
  vues.set(id, v);
}

/**
 * Retire les vues les plus anciennes au-delà de `max` (sans compter `affichee`), jamais
 * celles où `enCours(vue)` est vrai. Rend les identifiants retirés.
 */
export function bornerVues<T>(vues: Map<string, T>, affichee: string, enCours: (vue: T) => boolean, max = VUES_GARDEES): string[] {
  const retirees: string[] = [];
  let enTrop = vues.size - (vues.has(affichee) ? 1 : 0) - max;
  for (const [id, vue] of vues) {
    if (enTrop <= 0) break;
    if (id === affichee || enCours(vue)) continue;
    vues.delete(id);
    retirees.push(id);
    enTrop -= 1;
  }
  return retirees;
}

/**
 * l'espace gardait le fil complet (historique, images) de CHAQUE conversation
 * devenue active, pour les colonnes : il ne garde plus que ceux de `garder` (affichés).
 * Rend le même objet quand il n'y a rien à retirer.
 */
export function garderSeulement<T>(m: Record<string, T>, garder: Iterable<string>): Record<string, T> {
  const g = new Set(garder);
  const cles = Object.keys(m);
  if (cles.every((k) => g.has(k))) return m;
  const r: Record<string, T> = {};
  for (const k of cles) if (g.has(k)) r[k] = m[k];
  return r;
}

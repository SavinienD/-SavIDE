// axe:agents-ordre - ordre de la liste des agents : ceux qui travaillent (pastille orange) en tête,
// puis ceux qui attendent, puis les terminés, puis les archivés ; à rang égal, le plus récent d'abord.
// Un parent dont un sous-agent travaille remonte avec lui.
export type NoeudOrdre = {
  meta: { status: string; updatedAtMs: number; archived?: boolean };
  children: NoeudOrdre[];
};

export function rangStatut(status: string): number {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}

/** Meilleur rang du nœud et de ses descendants. */
export function rangNoeud(n: NoeudOrdre): number {
  let rang = rangStatut(n.meta.status) + (n.meta.archived ? 3 : 0);
  for (const enfant of n.children) rang = Math.min(rang, rangNoeud(enfant));
  return rang;
}

export function comparerAgents(a: NoeudOrdre, b: NoeudOrdre): number {
  return rangNoeud(a) - rangNoeud(b) || b.meta.updatedAtMs - a.meta.updatedAtMs;
}

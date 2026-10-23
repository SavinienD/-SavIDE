// axe:terminal-onglets - logique pure des onglets du terminal local (testee par tests/terminalTabs.test.cjs).
export const GIT_TAB_ID = "__git__";

/** Titre envoye par le shell qui n'est que le chemin de l'executable (pwsh sous Windows : « C:\Program Files\PowerShell\7\pwsh.exe »). */
export function isExecutablePathTitle(title: string): boolean {
  const t = title.trim().replace(/^"|"$/g, "");
  if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith("\\\\")) return true;
  if (/^\/(usr|bin|opt)\//.test(t) && !/\s/.test(t)) return true;
  return /\.(exe|com|bat|cmd)$/i.test(t);
}

/** Onglet reellement affiche : Git si demande, sinon une session existante (jamais un id orphelin). */
export function resolveActiveTab(activeId: string, sessionIds: string[]): string {
  if (activeId === GIT_TAB_ID) return GIT_TAB_ID;
  if (sessionIds.includes(activeId)) return activeId;
  return sessionIds[0] ?? GIT_TAB_ID;
}

/** Ctrl+Tab : parcourt Git puis les terminaux. */
export function cycleTab(activeId: string, sessionIds: string[], direction: 1 | -1): string {
  const order = [GIT_TAB_ID, ...sessionIds];
  const current = Math.max(0, order.indexOf(resolveActiveTab(activeId, sessionIds)));
  return order[(current + direction + order.length) % order.length];
}

// Mise à jour automatique : l'installation attend qu'aucun tour ni agent ne tourne.
// Chaque vue déclare son activité ici (source -> occupé ou non) ; le badge de mise à jour la lit.

const occupes = new Set<string>();

export function declarerActivite(source: string, occupe: boolean): void {
  if (occupe) occupes.add(source);
  else occupes.delete(source);
}

export function activiteEnCours(): boolean {
  return occupes.size > 0;
}

/// Décision pure (testée) : installer maintenant ?
export function doitInstallerMaintenant(
  info: { available: boolean; version?: string | null } | null,
  occupe: boolean,
): boolean {
  return !!info && info.available && !!info.version && !occupe;
}

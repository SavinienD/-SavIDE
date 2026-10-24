// Activité des vues (source -> occupé ou non) : chaque vue déclare ses tours/agents en cours.

const occupes = new Set<string>();

export function declarerActivite(source: string, occupe: boolean): void {
  if (occupe) occupes.add(source);
  else occupes.delete(source);
}

export function activiteEnCours(): boolean {
  return occupes.size > 0;
}

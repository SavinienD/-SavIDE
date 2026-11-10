// Terminaux par dossier : le service garde un pseudo-terminal par identifiant, et lancer un
// identifiant déjà pris arrête l'ancien. Les onglets s'appellent « terminal-1 », « terminal-2 »…
// dans chaque dossier : l'identifiant donné au service porte aussi le dossier, pour que les
// terminaux de deux dossiers vivent en même temps sans se remplacer.

/** Empreinte courte et stable d'un chemin (FNV-1a 32 bits, hexadécimal). */
export function empreinteDossier(chemin: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < chemin.length; i += 1) {
    h ^= chemin.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Identifiant du pseudo-terminal d'un onglet de terminal dans un dossier. */
export function identifiantPty(dossier: string, onglet: string): string {
  return `${onglet}@${empreinteDossier(dossier)}`;
}

/**
 * Dossiers dont le panneau de terminal reste monté : ceux qu'on a quittés avec des terminaux
 * vivants, plus le dossier ouvert s'il a son panneau. Ordre stable (premier monté d'abord).
 */
export function dossiersAvecTerminal(quittes: readonly string[], courant: string, courantMonte: boolean): string[] {
  const liste = quittes.filter((d) => d !== courant);
  if (courantMonte) liste.push(courant);
  return liste;
}

/** Au changement de dossier : le dossier quitté garde ses terminaux s'il en avait. */
export function quitterDossier(quittes: readonly string[], ancien: string, ancienMonte: boolean, nouveau: string): string[] {
  const liste = quittes.filter((d) => d !== ancien && d !== nouveau);
  if (ancienMonte) liste.push(ancien);
  return liste;
}

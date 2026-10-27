// axe:archive-erreur — message français quand l'archivage échoue (module pur,
// testé par tests/archiveErreur.test.cjs). Avant, l'erreur était avalée.
export function messageArchiveEchec(err: unknown): string {
  const brut = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const texte = brut.toLowerCase();
  if (/offline|hors ligne|transport|network|fetch/.test(texte)) {
    return "Archivage impossible : l'espace distant ne répond pas. Réessayez une fois reconnecté.";
  }
  if (/not ?found|introuvable|unknown session/.test(texte)) {
    return "Archivage impossible : le service ne trouve pas cette conversation (déjà archivée ou hors de cet espace).";
  }
  return brut
    ? `Archivage impossible : ${brut}`
    : "Archivage impossible : erreur inconnue.";
}

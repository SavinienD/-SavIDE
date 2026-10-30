// axe:mention-libre — conversation sans dossier : toutes les conversations partagent le
// dossier « scratch », chacune travaille dans scratch/<id>/. La recherche « @ fichier »
// ne propose que les fichiers de la conversation ouverte.
export function filtrerMentionsConversation<T extends { relativePath: string }>(
  files: T[],
  scope: string | null | undefined,
): T[] {
  if (!scope) return files;
  const prefixe = `${scope}/`;
  return files.filter((f) => f.relativePath.replace(/\\/g, "/").startsWith(prefixe));
}

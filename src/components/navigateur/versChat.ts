// « Envoyer à la conversation » : le texte va dans la saisie de la conversation
// active (ajouté à la fin, l'utilisateur écrit ensuite sa demande). Chaque saisie du
// chat s'inscrit ici pour sa conversation. Module sans React (testé par node).

type Inserer = (texte: string) => void;
const cibles = new Map<string, Inserer[]>();

export function enregistrerCibleChat(conversationId: string, inserer: Inserer): () => void {
  const pile = cibles.get(conversationId) ?? [];
  pile.push(inserer);
  cibles.set(conversationId, pile);
  return () => {
    const reste = (cibles.get(conversationId) ?? []).filter((f) => f !== inserer);
    if (reste.length) cibles.set(conversationId, reste);
    else cibles.delete(conversationId);
  };
}

/** Vrai si une saisie affichée a reçu le texte ; sinon l'appelant le copie. */
export function envoyerAuChat(conversationId: string, texte: string): boolean {
  const pile = cibles.get(conversationId);
  if (!pile?.length) return false;
  pile[pile.length - 1](texte);
  return true;
}

/** Texte de la saisie après ajout : à la fin, après une ligne vide ; curseur à la fin. */
export function ajouterAuTexte(actuel: string, ajout: string): string {
  const debut = actuel.replace(/\s+$/, "");
  return debut ? `${debut}\n\n${ajout}` : ajout;
}

/** Pour les tests. */
export function reinitialiserCibles(): void {
  cibles.clear();
}

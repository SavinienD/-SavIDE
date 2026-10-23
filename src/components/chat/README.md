# Chat — notes de conception

## Colonnes (axe:e17b)
- `colonnes.ts` : état pur `{ colonnes: string[][], focus }` (ouvrir, deplacer, retirer, ajouterColonne, focaliser, relire). Testé dans `tests/colonnesChat.test.cjs`.
- `Workspace.tsx` rend un `ChatPane` par colonne ; chaque pane reçoit les actions liées à SA conversation (`actionsConversation.ts`), jamais celles du fil actif.
- La colonne qui a le focus porte `activeConv` (titre, raccourcis, liste de gauche) ; cliquer dans une colonne lui donne le focus.
- Glisser un onglet (MIME `application/x-axe-onglet-chat`) vers une autre colonne ou sur « + » à droite.

## Bouton ✕ (`ChatCloseButton.tsx`)
Le bouton X n'est affiché que sur un chat détaché et sert à archiver ou ré-ancrer la conversation.
- Colonne normale : pas de ✕ dans l'en-tête (l'onglet garde sa croix « fermer l'onglet », qui ne supprime rien).
- Fenêtre détachée : ✕ ouvre un menu « Ré-ancrer » / « Archiver… ». Archiver demande une confirmation, appelle l'archive de l'espace puis retire l'id de `colonnesChat`. L'archive n'existe que sur un espace cloud.

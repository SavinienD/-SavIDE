// Avis « l'affichage a été relancé » : montré quand la page vient d'être rechargée par le
// gardien de l'appli (processus de rendu de la vue arrêté), jamais après un rechargement manuel.

type Ecouteur = () => void;

/** L'avis se ferme seul après ce délai. */
export const DUREE_AVIS_MS = 20_000;

let visible = false;
const ecouteurs = new Set<Ecouteur>();

function prevenir(): void {
  for (const f of [...ecouteurs]) f();
}

export function signalerRelance(): void {
  visible = true;
  prevenir();
}

export function fermerAvis(): void {
  if (!visible) return;
  visible = false;
  prevenir();
}

export function avisVisible(): boolean {
  return visible;
}

export function abonnerAvis(f: Ecouteur): () => void {
  ecouteurs.add(f);
  return () => {
    ecouteurs.delete(f);
  };
}

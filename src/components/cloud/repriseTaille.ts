// Session tmux partagée : sa fenêtre prend la taille du client le plus récent
// (window-size « latest »). Quand un autre client (portail web, SSH, autre fenêtre)
// a parlé en dernier, notre vue n'en montre que le coin haut-gauche : lignes coupées
// à droite, rien pour défiler. Renvoyer notre taille la reprend (tmux 3.5 : un
// redimensionnement rend le client « le plus récent »). On la renvoie quand
// l'utilisateur revient vers le terminal : focus, clic, retour sur la fenêtre.

type Cible = Pick<EventTarget, "addEventListener" | "removeEventListener">;
type Doc = Cible & { visibilityState?: string };

/** Branche les rappels ; rend la fonction qui les retire. */
export function reprendreTaille(
  hote: Cible,
  envoyer: () => void,
  fenetre: Cible | null = typeof window === "undefined" ? null : window,
  doc: Doc | null = typeof document === "undefined" ? null : document,
): () => void {
  let dernier = 0;
  const reprendre = () => {
    const t = Date.now();
    if (t - dernier < 150) return; // focus + clic du même geste : un seul envoi
    dernier = t;
    envoyer();
  };
  const visible = () => {
    if (!doc || doc.visibilityState === undefined || doc.visibilityState === "visible") reprendre();
  };
  hote.addEventListener("focusin", reprendre);
  hote.addEventListener("pointerdown", reprendre);
  fenetre?.addEventListener("focus", reprendre);
  doc?.addEventListener("visibilitychange", visible);
  return () => {
    hote.removeEventListener("focusin", reprendre);
    hote.removeEventListener("pointerdown", reprendre);
    fenetre?.removeEventListener("focus", reprendre);
    doc?.removeEventListener("visibilitychange", visible);
  };
}

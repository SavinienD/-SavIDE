// Réajustement de la grille du terminal quand la taille des cellules change sans que
// l'hôte change de taille.
//
// xterm arrondit la taille des cellules au pixel physique (largeur arrondie vers le bas,
// hauteur vers le haut, divisées par devicePixelRatio). Quand l'échelle change sans que le
// volet change de taille en CSS (fenêtre déplacée entre un écran Retina et un écran standard,
// réglage d'échelle de l'écran) ou quand les mesures de la police changent (police chargée
// après l'ouverture), les cellules grandissent ou rapetissent alors que le ResizeObserver de
// l'hôte ne se déclenche pas : la grille dépasse du volet (dernière colonne sous la barre de
// défilement, dernière ligne sous le bord) et le PTY garde l'ancienne taille.
// xterm ne signale pas ce changement (onDimensionsChange ne part que sur resize ou option) :
// on suit nous-mêmes l'échelle et le chargement des polices, puis on réajuste une image plus
// tard, quand xterm a recalculé ses cellules.

interface ListeMedia {
  addEventListener?: (type: "change", f: () => void) => void;
  removeEventListener?: (type: "change", f: () => void) => void;
  addListener?: (f: () => void) => void;
  removeListener?: (f: () => void) => void;
}

export interface FenetreMesures {
  devicePixelRatio: number;
  matchMedia: (requete: string) => ListeMedia;
  addEventListener: (type: "resize", f: () => void) => void;
  removeEventListener: (type: "resize", f: () => void) => void;
  requestAnimationFrame: (f: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
}

export interface PolicesMesures {
  ready?: Promise<unknown>;
  addEventListener?: (type: "loadingdone", f: () => void) => void;
  removeEventListener?: (type: "loadingdone", f: () => void) => void;
}

/** Appelle `reajuster` (une fois par image au plus) quand l'échelle de l'écran change ou
 *  quand des polices finissent de charger. Rend la fonction qui arrête le suivi. */
export function suivreMesuresTerminal(
  fenetre: FenetreMesures,
  polices: PolicesMesures | undefined,
  reajuster: () => void,
): () => void {
  let actif = true;
  let image: number | null = null;
  let echelle = fenetre.devicePixelRatio;
  let liste: ListeMedia | null = null;

  const planifier = () => {
    if (!actif || image !== null) return;
    image = fenetre.requestAnimationFrame(() => {
      image = null;
      if (actif) reajuster();
    });
  };
  const quitter = () => {
    if (!liste) return;
    if (liste.removeEventListener) liste.removeEventListener("change", surEchelle);
    else liste.removeListener?.(surEchelle);
    liste = null;
  };
  const ecouter = () => {
    quitter();
    echelle = fenetre.devicePixelRatio;
    // La requête ne vaut que pour l'échelle actuelle : on la refait à chaque changement.
    liste = fenetre.matchMedia(`(resolution: ${echelle}dppx)`);
    if (liste.addEventListener) liste.addEventListener("change", surEchelle);
    else liste.addListener?.(surEchelle);
  };
  function surEchelle() {
    if (!actif) return;
    ecouter();
    planifier();
  }
  // Certains moteurs ne signalent le changement d'échelle que par « resize ».
  const surTaille = () => {
    if (fenetre.devicePixelRatio !== echelle) surEchelle();
  };
  const surPolices = () => planifier();

  ecouter();
  fenetre.addEventListener("resize", surTaille);
  polices?.addEventListener?.("loadingdone", surPolices);
  void polices?.ready?.then(surPolices, () => undefined);

  return () => {
    actif = false;
    quitter();
    fenetre.removeEventListener("resize", surTaille);
    polices?.removeEventListener?.("loadingdone", surPolices);
    if (image !== null) fenetre.cancelAnimationFrame(image);
    image = null;
  };
}

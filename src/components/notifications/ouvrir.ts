// Ouvrir la conversation d'une notification du système, d'une carte de la
// vue « Tableau » ou de la cloche, quel que soit l'écran. L'espace affiché fournit son ouvreur
// (priorité 10 : conversation du dossier, autre dossier, journal d'un sous-agent) ; l'appli
// fournit le sien en secours (priorité 0 : depuis l'accueil). Module pur.

export type CibleOuverture = {
  sessionId: string;
  /** Dossier tel que le service l'écrit (préfixe \\?\ possible sous Windows). */
  dossier?: string;
  connexion?: string;
  sousAgent?: boolean;
  libre?: boolean;
  titre?: string;
};

export type Ouvreur = (cible: CibleOuverture) => boolean;

const ouvreurs: { ouvreur: Ouvreur; priorite: number }[] = [];

export function fournirOuvreur(ouvreur: Ouvreur, priorite = 0): () => void {
  const entree = { ouvreur, priorite };
  ouvreurs.push(entree);
  return () => {
    const i = ouvreurs.indexOf(entree);
    if (i >= 0) ouvreurs.splice(i, 1);
  };
}

/** Le premier ouvreur (priorité la plus haute, puis le plus récent) qui accepte la cible. */
export function ouvrirCible(cible: CibleOuverture | null | undefined): boolean {
  if (!cible || !cible.sessionId) return false;
  const ordre = ouvreurs.map((e, i) => ({ ...e, i })).sort((a, b) => b.priorite - a.priorite || b.i - a.i);
  for (const { ouvreur } of ordre) {
    try {
      if (ouvreur(cible)) return true;
    } catch {
      /* ouvreur suivant */
    }
  }
  return false;
}

/** Cible d'un événement de la cloche ou d'une notification (null : rien à ouvrir). */
export function cibleDe(ev: Partial<CibleOuverture> & { sessionId?: string; titre?: string } | null | undefined): CibleOuverture | null {
  if (!ev || !ev.sessionId) return null;
  return {
    sessionId: ev.sessionId,
    dossier: ev.dossier || undefined,
    connexion: ev.connexion || undefined,
    sousAgent: Boolean(ev.sousAgent),
    libre: Boolean(ev.libre),
    titre: ev.titre,
  };
}

/** Chemin du poste à partir de celui du service (préfixe \\?\ de Windows retiré). */
export function cheminPoste(dossier: string): string {
  return dossier.replace(/^\\\\\?\\/, "");
}

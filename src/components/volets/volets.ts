// axe:e6 — volets séparables, duplicables, réancrables.
//
// Un « volet » est une des cinq zones de travail de l'écran IDE : l'explorateur,
// le panneau bas (conversations / git / agents), l'éditeur, le terminal et le chat.
// Chaque volet peut être :
//   • ANCRÉ    — à sa place dans la mise en page : comportement historique ;
//   • DÉTACHÉ  — il vit dans une fenêtre flottante interne à l'application, et sa
//                place se replie en un bandeau « … détaché » avec un bouton Réancrer ;
//   • DUPLIQUÉ — une seconde fenêtre flottante, indépendante, du même volet.
//
// Règle de sûreté du lot : tant qu'aucun volet n'est détaché, la mise en page est
// exactement celle d'avant (le mécanisme est purement additif).
//
// Journal des positions : localStorage `axe:v2:volets`. Une fenêtre perdue hors de
// l'écran (résolution changée) est ramenée de force dans la vue au chargement.
import { useCallback, useEffect, useRef, useState } from "react";

export type VoletId = "explorateur" | "panneauBas" | "editeur" | "terminal" | "chat";

export type VoletFenetre = {
  /** « chat » pour le volet ancré détaché, « chat:1 », « chat:2 »… pour les copies. */
  cle: string;
  volet: VoletId;
  /** 0 = le volet ancré, détaché ; 1, 2… = copies indépendantes. */
  exemplaire: number;
  x: number;
  y: number;
  largeur: number;
  hauteur: number;
  z: number;
};

export const VOLET_NOMS: Record<VoletId, string> = {
  explorateur: "Explorateur",
  panneauBas: "Panneau bas",
  editeur: "Éditeur",
  terminal: "Terminal",
  chat: "Chat",
};

/** Ce que le menu « Dupliquer » propose : le terminal et l'éditeur se dupliquent
 *  volontiers, mais une copie du chat ouvre la même conversation — on l'autorise
 *  quand même, c'est utile pour lire le fil tout en écrivant plus haut. */
const TAILLE_PAR_DEFAUT: Record<VoletId, { largeur: number; hauteur: number }> = {
  explorateur: { largeur: 380, hauteur: 540 },
  panneauBas: { largeur: 460, hauteur: 420 },
  editeur: { largeur: 760, hauteur: 480 },
  terminal: { largeur: 680, hauteur: 320 },
  chat: { largeur: 460, hauteur: 560 },
};

const CLE_STOCKAGE = "axe:v2:volets";
const LARGEUR_MINI = 260;
const HAUTEUR_MINI = 160;
/** Bande de la fenêtre qui doit rester visible : on ne perd jamais un volet. */
const BORD_VISIBLE = 80;

function estVoletConnu(valeur: unknown): valeur is VoletId {
  return typeof valeur === "string" && valeur in VOLET_NOMS;
}

function nombreFini(valeur: unknown, defaut: number): number {
  return typeof valeur === "number" && Number.isFinite(valeur) ? valeur : defaut;
}

/** Ramène une fenêtre dans la vue : au chargement, après un changement d'écran,
 *  ou après un glissement trop loin. */
export function bornerFenetre(
  fenetre: VoletFenetre,
  largeurEcran: number,
  hauteurEcran: number,
): VoletFenetre {
  const largeur = Math.max(
    LARGEUR_MINI,
    Math.min(largeurEcran, nombreFini(fenetre.largeur, 420)),
  );
  const hauteur = Math.max(
    HAUTEUR_MINI,
    Math.min(hauteurEcran, nombreFini(fenetre.hauteur, 320)),
  );
  const x = Math.max(
    -(largeur - BORD_VISIBLE),
    Math.min(largeurEcran - BORD_VISIBLE, nombreFini(fenetre.x, 120)),
  );
  const y = Math.max(0, Math.min(hauteurEcran - 40, nombreFini(fenetre.y, 90)));
  return { ...fenetre, x, y, largeur, hauteur };
}

function charger(): VoletFenetre[] {
  if (typeof window === "undefined") return [];
  let brut: string | null = null;
  try {
    brut = window.localStorage.getItem(CLE_STOCKAGE);
  } catch {
    return [];
  }
  if (!brut) return [];
  try {
    const donnees: unknown = JSON.parse(brut);
    if (!Array.isArray(donnees)) return [];
    const vues = new Set<string>();
    const fenetres: VoletFenetre[] = [];
    for (const entree of donnees) {
      if (typeof entree !== "object" || entree === null) continue;
      const brut2 = entree as Record<string, unknown>;
      if (!estVoletConnu(brut2.volet)) continue;
      const cle = typeof brut2.cle === "string" && brut2.cle ? brut2.cle : brut2.volet;
      if (vues.has(cle)) continue;
      vues.add(cle);
      fenetres.push({
        cle,
        volet: brut2.volet,
        exemplaire: Math.max(0, Math.trunc(nombreFini(brut2.exemplaire, 0))),
        x: nombreFini(brut2.x, 120),
        y: nombreFini(brut2.y, 90),
        largeur: nombreFini(brut2.largeur, 420),
        hauteur: nombreFini(brut2.hauteur, 320),
        z: nombreFini(brut2.z, fenetres.length + 1),
      });
    }
    return fenetres;
  } catch {
    return [];
  }
}

export type VoletsApi = {
  fenetres: VoletFenetre[];
  /** Le volet ancré est-il parti dans une fenêtre flottante ? */
  estDetache: (volet: VoletId) => boolean;
  /** Les copies indépendantes d'un volet (exemplaire >= 1). */
  copiesDe: (volet: VoletId) => VoletFenetre[];
  detacher: (volet: VoletId) => void;
  dupliquer: (volet: VoletId) => void;
  /** Referme une fenêtre : le volet ancré revient à sa place, une copie disparaît. */
  reancrer: (cle: string) => void;
  /** Met la fenêtre au premier plan. */
  devant: (cle: string) => void;
  deplacer: (cle: string, x: number, y: number) => void;
  redimensionner: (cle: string, largeur: number, hauteur: number) => void;
  toutReancrer: () => void;
};

export function useVolets(): VoletsApi {
  const [fenetres, setFenetres] = useState<VoletFenetre[]>(() => charger());
  const zRef = useRef(
    fenetres.reduce((max, fenetre) => Math.max(max, fenetre.z), 0) + 1,
  );

  // Le journal s'écrit après le geste (glissement, redimensionnement) : pas à chaque
  // pixel, sans quoi le disque verrait cinquante écritures par seconde.
  useEffect(() => {
    const minuterie = window.setTimeout(() => {
      try {
        window.localStorage.setItem(CLE_STOCKAGE, JSON.stringify(fenetres));
      } catch {
        /* stockage plein ou refusé : on continue sans mémoire */
      }
    }, 400);
    return () => window.clearTimeout(minuterie);
  }, [fenetres]);

  // Un écran plus petit (ou une fenêtre réduite) ne doit jamais emporter un volet.
  useEffect(() => {
    const borner = () =>
      setFenetres((liste) =>
        liste.map((fenetre) =>
          bornerFenetre(fenetre, window.innerWidth, window.innerHeight),
        ),
      );
    borner();
    window.addEventListener("resize", borner);
    return () => window.removeEventListener("resize", borner);
  }, []);

  const devant = useCallback((cle: string) => {
    setFenetres((liste) => {
      const cible = liste.find((fenetre) => fenetre.cle === cle);
      if (!cible || cible.z >= zRef.current - 1) return liste;
      const z = zRef.current;
      zRef.current = z + 1;
      return liste.map((fenetre) => (fenetre.cle === cle ? { ...fenetre, z } : fenetre));
    });
  }, []);

  const ajouter = useCallback(
    (volet: VoletId, exemplaire: number) => {
      const defaut = TAILLE_PAR_DEFAUT[volet];
      const rang = exemplaire;
      setFenetres((liste) => {
        const cle = exemplaire === 0 ? volet : `${volet}:${exemplaire}`;
        if (liste.some((fenetre) => fenetre.cle === cle)) return liste;
        const z = zRef.current;
        zRef.current = z + 1;
        return [
          ...liste,
          bornerFenetre(
            {
              cle,
              volet,
              exemplaire,
              // Les fenêtres en cascade : la nième s'ouvre un peu plus bas à droite.
              x: 140 + rang * 34,
              y: 100 + rang * 30,
              largeur: defaut.largeur,
              hauteur: defaut.hauteur,
              z,
            },
            window.innerWidth,
            window.innerHeight,
          ),
        ];
      });
    },
    [],
  );

  const detacher = useCallback(
    (volet: VoletId) => {
      ajouter(volet, 0);
      // Détacher un volet déjà détaché le remet devant.
      devant(volet);
    },
    [ajouter, devant],
  );

  const dupliquer = useCallback(
    (volet: VoletId) => {
      setFenetres((liste) => {
        const dejaLa = liste.filter((fenetre) => fenetre.volet === volet);
        const prochain =
          dejaLa.reduce((max, fenetre) => Math.max(max, fenetre.exemplaire), 0) + 1;
        const defaut = TAILLE_PAR_DEFAUT[volet];
        const z = zRef.current;
        zRef.current = z + 1;
        return [
          ...liste,
          bornerFenetre(
            {
              cle: `${volet}:${prochain}`,
              volet,
              exemplaire: prochain,
              x: 120 + prochain * 40,
              y: 90 + prochain * 36,
              largeur: defaut.largeur,
              hauteur: defaut.hauteur,
              z,
            },
            window.innerWidth,
            window.innerHeight,
          ),
        ];
      });
    },
    [],
  );

  const reancrer = useCallback((cle: string) => {
    setFenetres((liste) => liste.filter((fenetre) => fenetre.cle !== cle));
  }, []);

  const deplacer = useCallback((cle: string, x: number, y: number) => {
    setFenetres((liste) =>
      liste.map((fenetre) =>
        fenetre.cle === cle
          ? bornerFenetre({ ...fenetre, x, y }, window.innerWidth, window.innerHeight)
          : fenetre,
      ),
    );
  }, []);

  const redimensionner = useCallback(
    (cle: string, largeur: number, hauteur: number) => {
      setFenetres((liste) =>
        liste.map((fenetre) =>
          fenetre.cle === cle
            ? bornerFenetre(
                { ...fenetre, largeur, hauteur },
                window.innerWidth,
                window.innerHeight,
              )
            : fenetre,
        ),
      );
    },
    [],
  );

  const toutReancrer = useCallback(() => setFenetres([]), []);

  return {
    fenetres,
    estDetache: (volet) => fenetres.some((f) => f.volet === volet && f.exemplaire === 0),
    copiesDe: (volet) => fenetres.filter((f) => f.volet === volet && f.exemplaire >= 1),
    detacher,
    dupliquer,
    reancrer,
    devant,
    deplacer,
    redimensionner,
    toutReancrer,
  };
}

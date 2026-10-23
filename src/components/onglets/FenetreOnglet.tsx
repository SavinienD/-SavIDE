// axe:e15 — une fenêtre flottante pour UN onglet détaché (terminal, chat, fichier).
//
// Pourquoi un composant à part plutôt que la couche des volets d'E6 : un volet
// détache un PANNEAU entier, ici on détache un onglet. Le geste est le même que
// dans un navigateur — on tire l'onglet dehors, il vit devant, et on le remet en
// place en le refermant. La géométrie est gardée par onglet (localStorage), et
// toujours ramenée dans l'écran pour qu'une fenêtre ne se perde pas hors champ.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";

type Geometrie = { x: number; y: number; w: number; h: number };

const CLE_GEOMETRIE = "axe:v2:fenetres";
const LARGEUR_MIN = 360;
const HAUTEUR_MIN = 220;
// La barre de titre doit rester attrapable : c'est elle qui permet de ramener la
// fenêtre, donc on ne la laisse jamais sortir de l'écran.
const MARGE = 8;

function lireToutes(): Record<string, Geometrie> {
  try {
    const brut = window.localStorage.getItem(CLE_GEOMETRIE);
    if (!brut) return {};
    const objet = JSON.parse(brut) as Record<string, Geometrie>;
    return objet && typeof objet === "object" ? objet : {};
  } catch {
    return {};
  }
}

function dansLEcran(geo: Geometrie): Geometrie {
  const largeur = window.innerWidth;
  const hauteur = window.innerHeight;
  const w = Math.max(LARGEUR_MIN, Math.min(geo.w, largeur - MARGE * 2));
  const h = Math.max(HAUTEUR_MIN, Math.min(geo.h, hauteur - MARGE * 2));
  const x = Math.min(Math.max(MARGE, geo.x), Math.max(MARGE, largeur - w - MARGE));
  const y = Math.min(Math.max(MARGE, geo.y), Math.max(MARGE, hauteur - 48));
  return { x, y, w, h };
}

function geometrieParDefaut(id: string): Geometrie {
  // Décalage en cascade : deux fenêtres détachées ne se cachent pas l'une l'autre.
  const decalage = (Math.abs(Number.parseInt(id.slice(-2), 36)) % 6) * 24;
  return dansLEcran({
    x: 160 + decalage,
    y: 120 + decalage,
    w: Math.min(760, window.innerWidth - 260),
    h: Math.min(460, window.innerHeight - 220),
  });
}

function enregistrer(id: string, geo: Geometrie) {
  try {
    const toutes = lireToutes();
    toutes[id] = geo;
    window.localStorage.setItem(CLE_GEOMETRIE, JSON.stringify(toutes));
  } catch {
    /* stockage plein ou interdit : la fenêtre reste utilisable */
  }
}

// Ordre de plan croissant : la fenêtre touchée passe devant les précédentes.
let planCompteur = 40;

type Props = {
  id: string;
  titre: string;
  sousTitre?: string;
  icone?: string;
  children: ReactNode;
  /** Refermer la fenêtre = réancrer l'onglet (on ne perd rien). */
  onClose: () => void;
  /** Boutons de plus dans l'en-tête (ex. le ✕ du chat détaché). */
  extra?: ReactNode;
};

export function FenetreOnglet({ id, titre, sousTitre, icone, children, onClose, extra }: Props) {
  // axe:e18 — double-clic sur l'en-tete : la fenetre prend tout l'ecran de
  // l'application (second double-clic : elle rend sa taille). C'est le geste le
  // plus rapide pour gagner du terrain quand on detache.
  const [plein, setPlein] = useState(false);
  const [geo, setGeo] = useState<Geometrie>(() => {
    const gardee = lireToutes()[id];
    return gardee ? dansLEcran(gardee) : geometrieParDefaut(id);
  });
  const [plan, setPlan] = useState(() => (planCompteur += 1));
  const [actif, setActif] = useState<"rien" | "deplacer" | "taille">("rien");
  const depart = useRef<{ x: number; y: number; geo: Geometrie } | null>(null);

  const devant = useCallback(() => setPlan((planCompteur += 1)), []);

  // On garde la géométrie en mémoire quand l'écran change de taille : une fenêtre
  // agrandie puis réduite ne doit pas sortir du cadre.
  useEffect(() => {
    const redimension = () => setGeo((actuel) => dansLEcran(actuel));
    window.addEventListener("resize", redimension);
    return () => window.removeEventListener("resize", redimension);
  }, []);

  useEffect(() => {
    if (actif === "rien") return;
    const bouger = (event: PointerEvent) => {
      const base = depart.current;
      if (!base) return;
      const dx = event.clientX - base.x;
      const dy = event.clientY - base.y;
      setGeo(
        actif === "deplacer"
          ? dansLEcran({ ...base.geo, x: base.geo.x + dx, y: base.geo.y + dy })
          : dansLEcran({
              ...base.geo,
              w: Math.max(LARGEUR_MIN, base.geo.w + dx),
              h: Math.max(HAUTEUR_MIN, base.geo.h + dy),
            }),
      );
    };
    const lacher = () => {
      setActif("rien");
      depart.current = null;
      setGeo((actuel) => {
        enregistrer(id, actuel);
        return actuel;
      });
    };
    window.addEventListener("pointermove", bouger);
    window.addEventListener("pointerup", lacher);
    return () => {
      window.removeEventListener("pointermove", bouger);
      window.removeEventListener("pointerup", lacher);
    };
  }, [actif, id]);

  const geoAffichee: Geometrie = plein
    ? {
        x: 8,
        y: 8,
        w: Math.max(LARGEUR_MIN, window.innerWidth - 16),
        h: Math.max(HAUTEUR_MIN, window.innerHeight - 16),
      }
    : geo;

  return (
    <div
      className="fenetre-onglet"
      style={{ left: geoAffichee.x, top: geoAffichee.y, width: geoAffichee.w, height: geoAffichee.h, zIndex: plan }}
      onPointerDown={devant}
      role="dialog"
      aria-label={titre}
    >
      <div
        className="fenetre-onglet__tete"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          depart.current = { x: event.clientX, y: event.clientY, geo };
          setActif(plein ? "rien" : "deplacer");
        }}
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          setPlein((valeur) => !valeur);
        }}
      >
        <Icon icon={icone ?? "solar:widget-linear"} width={13} height={13} />
        <span className="fenetre-onglet__titre">{titre}</span>
        {sousTitre ? <span className="fenetre-onglet__sous-titre">{sousTitre}</span> : null}
        {extra}
        <button
          type="button"
          className="fenetre-onglet__btn"
          title="Réancrer l'onglet (la fenêtre se referme, rien n'est perdu)"
          aria-label="Réancrer l'onglet"
          onClick={onClose}
        >
          <Icon icon="solar:minimize-square-2-linear" width={13} height={13} />
        </button>
      </div>
      <div className="fenetre-onglet__corps">{children}</div>
      <div
        className="fenetre-onglet__coin"
        title="Redimensionner"
        onPointerDown={(event) => {
          event.stopPropagation();
          depart.current = { x: event.clientX, y: event.clientY, geo };
          setActif("taille");
        }}
      />
    </div>
  );
}

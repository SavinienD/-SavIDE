// axe:e6 — la couche des volets : fenêtres flottantes, boutons du volet ancré,
// bandeau de rappel et menu de la barre de titre.
//
// Tout se passe DANS la fenêtre de l'application (pas de fenêtre système Tauri) :
// une fenêtre flottante est déplaçable par son en-tête, redimensionnable par son
// coin, et passe devant les autres au clic. Positions et tailles sont gardées par
// `useVolets` (localStorage).
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import {
  VOLET_NOMS,
  type VoletFenetre,
  type VoletId,
  type VoletsApi,
} from "./volets";

const ICONE_DETACHER = "solar:maximize-square-linear";
const ICONE_DUPLIQUER = "solar:copy-linear";
const ICONE_REANCRER = "solar:pin-bold";
const ICONE_FERMER = "solar:close-circle-linear";

// ---------------------------------------------------------------------------
// Fenêtres flottantes
// ---------------------------------------------------------------------------

type FlottantsProps = {
  volets: VoletsApi;
  /** Rend le contenu d'une fenêtre (le volet lui-même, fourni par Workspace). */
  contenu: (fenetre: VoletFenetre) => ReactNode;
};

export function VoletsFlottants({ volets, contenu }: FlottantsProps) {
  const geste = useRef<
    | { type: "deplacer"; cle: string; dx: number; dy: number }
    | { type: "redimensionner"; cle: string; x: number; y: number }
    | null
  >(null);

  const commencer = (
    evenement: ReactPointerEvent<HTMLElement>,
    fenetre: VoletFenetre,
    type: "deplacer" | "redimensionner",
  ) => {
    if (type === "deplacer" && (evenement.target as HTMLElement).closest("button")) {
      return;
    }
    evenement.preventDefault();
    evenement.currentTarget.setPointerCapture(evenement.pointerId);
    volets.devant(fenetre.cle);
    geste.current =
      type === "deplacer"
        ? {
            type,
            cle: fenetre.cle,
            dx: evenement.clientX - fenetre.x,
            dy: evenement.clientY - fenetre.y,
          }
        : { type, cle: fenetre.cle, x: fenetre.x, y: fenetre.y };
  };

  const suivre = (evenement: ReactPointerEvent<HTMLElement>) => {
    const courant = geste.current;
    if (!courant) return;
    if (courant.type === "deplacer") {
      volets.deplacer(courant.cle, evenement.clientX - courant.dx, evenement.clientY - courant.dy);
    } else {
      volets.redimensionner(
        courant.cle,
        evenement.clientX - courant.x,
        evenement.clientY - courant.y,
      );
    }
  };

  const terminer = () => {
    geste.current = null;
  };

  if (volets.fenetres.length === 0) return null;

  return (
    <div className="volets-flottants" aria-live="polite">
      {volets.fenetres.map((fenetre) => (
        <section
          key={fenetre.cle}
          className="volet-flottant"
          style={{
            left: fenetre.x,
            top: fenetre.y,
            width: fenetre.largeur,
            height: fenetre.hauteur,
            zIndex: 40 + fenetre.z,
          }}
          onPointerDown={() => volets.devant(fenetre.cle)}
          aria-label={`${VOLET_NOMS[fenetre.volet]} flottant`}
        >
          <header
            className="volet-flottant__entete"
            onPointerDown={(evenement) => commencer(evenement, fenetre, "deplacer")}
            onPointerMove={suivre}
            onPointerUp={terminer}
            onPointerCancel={terminer}
            title="Déplacer ce volet"
          >
            <span className="volet-flottant__nom">
              <Icon icon={ICONE_DETACHER} width={13} height={13} aria-hidden />
              {VOLET_NOMS[fenetre.volet]}
              {fenetre.exemplaire > 0 ? " · copie" : ""}
            </span>
            <span className="volet-flottant__actions">
              <button
                type="button"
                className="volet-flottant__bouton"
                onClick={() => volets.reancrer(fenetre.cle)}
                title={
                  fenetre.exemplaire > 0
                    ? "Fermer cette copie"
                    : "Réancrer ce volet à sa place"
                }
              >
                <Icon
                  icon={fenetre.exemplaire > 0 ? ICONE_FERMER : ICONE_REANCRER}
                  width={14}
                  height={14}
                  aria-hidden
                />
                {fenetre.exemplaire > 0 ? "Fermer" : "Réancrer"}
              </button>
            </span>
          </header>
          <div className="volet-flottant__contenu">{contenu(fenetre)}</div>
          <div
            className="volet-flottant__poignee"
            title="Redimensionner"
            onPointerDown={(evenement) => commencer(evenement, fenetre, "redimensionner")}
            onPointerMove={suivre}
            onPointerUp={terminer}
            onPointerCancel={terminer}
          />
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Boutons du volet ancré (intégrés à son en-tête)
// ---------------------------------------------------------------------------

type OutilsProps = {
  volet: VoletId;
  volets: VoletsApi;
  /** Classe de base des boutons de l'hôte (le style suit le panneau). */
  classeBouton?: string;
};

export function VoletOutils({ volet, volets, classeBouton }: OutilsProps) {
  const nom = VOLET_NOMS[volet];
  const detache = volets.estDetache(volet);
  const classes = `${classeBouton ?? "volet-outils__bouton"}`;
  return (
    <span className="volet-outils">
      <button
        type="button"
        className={classes}
        data-actif={detache ? "true" : "false"}
        onClick={() => (detache ? volets.reancrer(volet) : volets.detacher(volet))}
        title={detache ? `Réancrer ${nom.toLowerCase()}` : `Détacher ${nom.toLowerCase()} dans une fenêtre`}
        aria-label={detache ? `Réancrer ${nom}` : `Détacher ${nom}`}
      >
        <Icon icon={detache ? ICONE_REANCRER : ICONE_DETACHER} width={14} height={14} />
      </button>
      <button
        type="button"
        className={classes}
        onClick={() => volets.dupliquer(volet)}
        title={`Dupliquer ${nom.toLowerCase()} dans une seconde fenêtre`}
        aria-label={`Dupliquer ${nom}`}
      >
        <Icon icon={ICONE_DUPLIQUER} width={13} height={13} />
      </button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Bandeau de rappel d'un volet détaché
// ---------------------------------------------------------------------------

type RappelProps = {
  volet: VoletId;
  volets: VoletsApi;
  /** « vertical » : le volet occupait une colonne ; « horizontal » : une bande. */
  sens?: "vertical" | "horizontal";
};

export function VoletRappel({
  volet,
  volets,
  sens = "vertical",
  compact = false,
}: RappelProps & { compact?: boolean }) {
  const nom = VOLET_NOMS[volet];
  // axe:e18 — en liseré : plus de pave qui mange la place, juste l'icone qui dit
  // « ce volet est detache, clique pour le remettre ». C'est ca, gagner du terrain.
  if (compact) {
    return (
      <div className="volet-repli" data-sens={sens} title={`${nom} détaché — cliquer pour réancrer`}>
        <button
          type="button"
          className="volet-repli__bouton"
          onClick={() => volets.reancrer(volet)}
          aria-label={`Réancrer ${nom}`}
        >
          <Icon icon={ICONE_DETACHER} width={14} height={14} />
        </button>
        <span className="volet-repli__nom">{nom}</span>
      </div>
    );
  }
  return (
    <div className="volet-rappel" data-sens={sens}>
      <span className="volet-rappel__texte">
        <Icon icon={ICONE_DETACHER} width={13} height={13} aria-hidden />
        {nom} détaché
      </span>
      <button
        type="button"
        className="volet-rappel__bouton"
        onClick={() => volets.reancrer(volet)}
        title={`Remettre ${nom.toLowerCase()} à sa place`}
      >
        Réancrer
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Menu « Volets » de la barre de titre
// ---------------------------------------------------------------------------

const ORDRE: VoletId[] = ["explorateur", "panneauBas", "editeur", "terminal", "chat"];

export function VoletsMenu({ volets }: { volets: VoletsApi }) {
  const [ouvert, setOuvert] = useState(false);
  const racine = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ouvert) return;
    const fermerAuClic = (evenement: PointerEvent) => {
      if (!racine.current?.contains(evenement.target as Node)) setOuvert(false);
    };
    const fermerAuClavier = (evenement: KeyboardEvent) => {
      if (evenement.key === "Escape") setOuvert(false);
    };
    window.addEventListener("pointerdown", fermerAuClic);
    window.addEventListener("keydown", fermerAuClavier);
    return () => {
      window.removeEventListener("pointerdown", fermerAuClic);
      window.removeEventListener("keydown", fermerAuClavier);
    };
  }, [ouvert]);

  const total = volets.fenetres.length;

  return (
    <div className="volets-menu" ref={racine}>
      <button
        type="button"
        className="titlebar__btn"
        data-on={total > 0 ? "true" : "false"}
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((valeur) => !valeur)}
        title="Détacher, dupliquer ou réancrer un volet"
      >
        <Icon icon="solar:widget-4-linear" width={12} height={12} />
        Volets
        {total > 0 ? <span className="volets-menu__compte">{total}</span> : null}
      </button>
      {ouvert ? (
        <div className="volets-menu__popover" role="menu">
          <p className="volets-menu__aide">
            Détacher sort le volet dans une fenêtre (la place se replie). Dupliquer en ouvre une
            seconde, indépendante. Réancrer le remet à sa place.
          </p>
          <ul className="volets-menu__liste">
            {ORDRE.map((volet) => {
              const detache = volets.estDetache(volet);
              const copies = volets.copiesDe(volet).length;
              return (
                <li key={volet} className="volets-menu__ligne">
                  <span className="volets-menu__volet">
                    {VOLET_NOMS[volet]}
                    <span className="volets-menu__etat">
                      {detache ? "détaché" : "ancré"}
                      {copies > 0 ? ` · ${copies} copie${copies > 1 ? "s" : ""}` : ""}
                    </span>
                  </span>
                  <span className="volets-menu__actions">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() =>
                        detache ? volets.reancrer(volet) : volets.detacher(volet)
                      }
                    >
                      {detache ? "Réancrer" : "Détacher"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => volets.dupliquer(volet)}
                    >
                      Dupliquer
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
          {total > 0 ? (
            <button
              type="button"
              className="volets-menu__tout"
              onClick={() => {
                volets.toutReancrer();
                setOuvert(false);
              }}
            >
              Tout réancrer
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

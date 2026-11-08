// liste « Modèle » du compositeur : bornée à la hauteur de la fenêtre et qui
// défile, ouverte vers le haut ou vers le bas selon la place, recherche au-delà de 12 modèles,
// un groupe par fournisseur et par compte (e-mail en sous-titre).
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "@iconify/react";
import type { ModelEntry } from "../../lib/models";
import {
  filtrerModeles,
  groupesModeles,
  placementMenu,
  SEUIL_RECHERCHE,
  type PlacementMenu,
} from "../../lib/menuModeles";

type Props = {
  modeles: readonly ModelEntry[];
  choisi: string;
  ancre: RefObject<HTMLElement | null>;
  titreFournisseur: (provider: string, entree: ModelEntry) => string;
  iconeFournisseur: (entree: ModelEntry) => string | undefined;
  onChoisir: (value: string) => void;
};

export function MenuModeles({ modeles, choisi, ancre, titreFournisseur, iconeFournisseur, onChoisir }: Props) {
  const [texte, setTexte] = useState("");
  const [actif, setActif] = useState(0);
  const [place, setPlace] = useState<(PlacementMenu & { largeurMax: number; decalage: number }) | null>(null);
  const listeRef = useRef<HTMLDivElement | null>(null);
  const rechercheVisible = modeles.length > SEUIL_RECHERCHE;
  const visibles = useMemo(
    () => (rechercheVisible ? filtrerModeles(modeles, texte, (p) => titreFournisseur(p, modeles.find((m) => m.provider === p)!)) : [...modeles]),
    [modeles, texte, rechercheVisible, titreFournisseur],
  );
  const groupes = useMemo(() => groupesModeles(visibles, titreFournisseur), [visibles, titreFournisseur]);

  // Place mesurée à l'ouverture et quand la fenêtre change de taille.
  useLayoutEffect(() => {
    const mesurer = () => {
      const r = ancre.current?.getBoundingClientRect();
      if (!r) return;
      // Place utilisable : la colonne du chat (sous la barre de titre), dans la fenêtre.
      const col = ancre.current?.closest(".chat-col")?.getBoundingClientRect();
      const zone = { haut: Math.max(0, col?.top ?? 0), bas: Math.min(window.innerHeight, col?.bottom ?? window.innerHeight) };
      // Largeur bornée à la colonne (volet étroit, e-mail long) : le reste passe en « … ».
      const droite = Math.min(window.innerWidth, col?.right ?? window.innerWidth);
      // Moins de 180 px (largeur minimale de la liste, .composer__popover) à droite du bouton (boutons
      // ajoutés devant lui, colonne étroite) : la liste glisse vers la gauche pour rester dans la
      // colonne, sans passer son bord gauche.
      const dispo = Math.floor(droite - r.left - 8);
      const gauche = Math.max(0, col?.left ?? 0) + 8;
      const decalage = dispo < 180 ? Math.min(0, Math.max(dispo - 180, Math.floor(gauche - r.left))) : 0;
      setPlace({ ...placementMenu(r, zone), largeurMax: Math.max(180, dispo - decalage), decalage });
    };
    mesurer();
    window.addEventListener("resize", mesurer);
    return () => window.removeEventListener("resize", mesurer);
  }, [ancre]);

  // Le modèle choisi est visible à l'ouverture (liste défilée jusqu'à lui).
  useLayoutEffect(() => {
    if (!place) return;
    listeRef.current
      ?.querySelector<HTMLElement>(".composer__popover-row[data-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [place]);

  useEffect(() => setActif(0), [texte]);

  useEffect(() => {
    if (!rechercheVisible || !texte) return;
    listeRef.current
      ?.querySelector<HTMLElement>(".composer__popover-row[data-actif='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [actif, rechercheVisible, texte]);

  const touche = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = visibles.length;
      if (!n) return;
      setActif((i) => (event.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const cible = visibles[actif] ?? visibles[0];
      if (cible) onChoisir(cible.value);
    }
  };

  let rang = -1;
  return (
    <div
      className="composer__popover composer__popover--modeles"
      role="menu"
      aria-label="Modèle"
      data-direction={place?.direction ?? "haut"}
      style={place ? { maxHeight: place.hauteurMax, maxWidth: place.largeurMax, left: place.decalage || undefined } : { visibility: "hidden" }}
    >
      {rechercheVisible && (
        <input
          className="composer__popover-recherche"
          data-champ="recherche-modele"
          type="search"
          autoFocus
          spellCheck={false}
          placeholder="Rechercher un modèle…"
          aria-label="Rechercher un modèle"
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          onKeyDown={touche}
        />
      )}
      <div className="composer__popover-liste" ref={listeRef}>
        {groupes.map((g) => (
          <Fragment key={g.cle}>
            <div className="axe-model-group" role="presentation" data-compte={g.sousTitre ? "true" : undefined}>
              <span>{g.titre}</span>
              {g.sousTitre && <span className="axe-model-group__compte" title={g.sousTitre}>{g.sousTitre}</span>}
            </div>
            {g.modeles.map((m) => {
              rang += 1;
              const selected = m.value === choisi;
              const icone = iconeFournisseur(m);
              return (
                <button
                  key={m.value}
                  type="button"
                  className="composer__popover-row"
                  data-selected={selected ? "true" : "false"}
                  data-valeur={m.value}
                  data-actif={rechercheVisible && texte && rang === actif ? "true" : undefined}
                  onClick={() => onChoisir(m.value)}
                >
                  <span className="composer__popover-label">
                    {icone && <Icon icon={icone} width={13} height={13} />}
                    <span>{m.label}</span>
                  </span>
                  {selected && (
                    <Icon icon="solar:check-read-linear" width={13} height={13} className="composer__popover-check" />
                  )}
                </button>
              );
            })}
          </Fragment>
        ))}
        {visibles.length === 0 && <div className="composer__popover-vide">Aucun modèle</div>}
      </div>
    </div>
  );
}

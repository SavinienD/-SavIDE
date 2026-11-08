// Fenêtre commune de Ctrl+P et Ctrl+K : un champ, une liste, tout au clavier.
// ↑ ↓ (Page préc. / suiv.) choisissent, Entrée ouvre, Ctrl+Entrée ouvre dans une autre colonne
// quand l'appelant le permet, Échap ferme et rend le focus là où il était.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { morceaux } from "./flou";
import "./palette.css";

export type ElementPalette = {
  id: string;
  /** Icône iconify (solar:…, vscode-icons:…). */
  icone: string;
  titre: string;
  /** Positions à surligner dans le titre. */
  marquesTitre?: readonly number[];
  /** Ligne secondaire (dossier, extrait…). */
  detail?: string;
  marquesDetail?: readonly number[];
  /** Petit texte à droite (« récent », date…). */
  indication?: string;
  /** Titre de groupe : affiché quand il change d'un élément au suivant. */
  groupe?: string;
  /** Variante d'affichage (« extrait » : texte d'une conversation sur deux lignes). */
  genre?: string;
};

type Props = {
  /** Nom de la fenêtre pour les lecteurs d'écran. */
  titre: string;
  /** Attribut data-palette (styles, banc). */
  genre: string;
  placeholder: string;
  requete: string;
  onRequete: (requete: string) => void;
  elements: ElementPalette[];
  /** Texte à la place de la liste (chargement, aucun résultat), sinon null. */
  etat?: string | null;
  /** Ligne d'information sous la liste (liste coupée, durée de recherche…). */
  note?: ReactNode;
  /** Touches rappelées en bas. */
  aide?: { touches: string; action: string }[];
  onChoisir: (element: ElementPalette, options: { autreColonne: boolean }) => void;
  onFermer: () => void;
};

const PAS_PAGE = 8;

// Parties non surlignées en texte simple (pas de <span>) : le titre reste un seul libellé.
function Texte({ texte, marques }: { texte: string; marques?: readonly number[] }) {
  return <>{morceaux(texte, marques).map((m, i) => (m.marque ? <mark key={i}>{m.texte}</mark> : m.texte))}</>;
}

export function Palette({ titre, genre, placeholder, requete, onRequete, elements, etat, note, aide, onChoisir, onFermer }: Props) {
  const [actif, setActif] = useState(0);
  const champRef = useRef<HTMLInputElement | null>(null);
  const listeRef = useRef<HTMLDivElement | null>(null);
  const retourRef = useRef<Element | null>(null);
  const idListe = useId();

  // Focus au champ ; à la fermeture, il revient là où il était.
  useLayoutEffect(() => {
    retourRef.current = document.activeElement;
    champRef.current?.focus();
    return () => {
      const el = retourRef.current as HTMLElement | null;
      if (el && typeof el.focus === "function" && document.contains(el)) el.focus();
    };
  }, []);

  // Nouvelle liste : on repart du premier élément.
  const cle = elements.map((e) => e.id).join("\n");
  useEffect(() => setActif(0), [cle]);

  useEffect(() => {
    const el = listeRef.current?.querySelector<HTMLElement>(`[data-index="${actif}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [actif, cle]);

  const choisir = (index: number, autreColonne: boolean) => {
    const element = elements[index];
    if (element) onChoisir(element, { autreColonne });
  };

  const touche = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const n = elements.length;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onFermer();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      choisir(actif, e.ctrlKey || e.metaKey);
      return;
    }
    if (!n) return;
    const aller = (i: number) => {
      e.preventDefault();
      setActif(((i % n) + n) % n);
    };
    if (e.key === "ArrowDown") aller(actif + 1);
    else if (e.key === "ArrowUp") aller(actif - 1);
    else if (e.key === "PageDown") aller(Math.min(n - 1, actif + PAS_PAGE));
    else if (e.key === "PageUp") aller(Math.max(0, actif - PAS_PAGE));
  };

  let groupePrecedent: string | undefined;
  return (
    <div className="palette-fond" onPointerDown={(e) => e.target === e.currentTarget && onFermer()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label={titre} data-palette={genre}>
        <div className="palette__champ">
          <Icon icon="solar:magnifer-linear" width={15} height={15} aria-hidden />
          <input
            ref={champRef}
            value={requete}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls={idListe}
            aria-activedescendant={elements[actif] ? `${idListe}-${actif}` : undefined}
            onChange={(e) => onRequete(e.target.value)}
            onKeyDown={touche}
          />
        </div>
        <div className="palette__liste" role="listbox" id={idListe} ref={listeRef} aria-label={titre}>
          {etat ? <div className="palette__etat">{etat}</div> : null}
          {!etat &&
            elements.map((el, i) => {
              const titreGroupe = el.groupe && el.groupe !== groupePrecedent ? el.groupe : null;
              groupePrecedent = el.groupe;
              return (
                <div key={el.id} className="palette__bloc" role="presentation">
                  {titreGroupe ? (
                    <div className="palette__groupe" role="presentation">
                      {titreGroupe}
                    </div>
                  ) : null}
                  <div
                    id={`${idListe}-${i}`}
                    role="option"
                    aria-selected={i === actif}
                    className="palette__element"
                    data-index={i}
                    data-actif={i === actif ? "true" : "false"}
                    data-genre={el.genre}
                    onPointerMove={() => i !== actif && setActif(i)}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={(e) => choisir(i, e.ctrlKey || e.metaKey)}
                  >
                    <Icon icon={el.icone} width={16} height={16} className="palette__icone" aria-hidden />
                    <span className="palette__textes">
                      <span className="palette__titre" title={el.titre}>
                        <Texte texte={el.titre} marques={el.marquesTitre} />
                      </span>
                      {el.detail ? (
                        <span className="palette__detail" title={el.detail}>
                          <Texte texte={el.detail} marques={el.marquesDetail} />
                        </span>
                      ) : null}
                    </span>
                    {el.indication ? <span className="palette__indication">{el.indication}</span> : null}
                  </div>
                </div>
              );
            })}
        </div>
        {note ? <div className="palette__note">{note}</div> : null}
        {aide?.length ? (
          <div className="palette__aide" aria-hidden>
            {aide.map((a) => (
              <span key={a.touches} className="palette__aide-item">
                <kbd>{a.touches}</kbd>
                {a.action}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

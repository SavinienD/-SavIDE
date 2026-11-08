// Barre des terminaux : « Terminaux ouverts » (liste, aller à, arrêter, tout arrêter) et
// « Plus d'actions » (rechercher, copier toute la sortie, scinder le terminal).
import { useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { infoBulle } from "../../axe/raccourcis";
import { MenuFlottant } from "./MenuFlottant";

export type LigneTerminal = { id: string; titre: string; agent: boolean; etat: string; enCours: boolean; actif: boolean };

export function BoutonTerminauxOuverts({
  lignes,
  onAller,
  onArreter,
  onToutArreter,
}: {
  lignes: LigneTerminal[];
  onAller: (id: string) => void;
  onArreter: (id: string) => void;
  onToutArreter: () => void;
}) {
  const bouton = useRef<HTMLButtonElement | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const enCours = lignes.filter((l) => l.enCours).length;
  return (
    <>
      <button
        ref={bouton}
        type="button"
        className="terminal-action"
        data-action="terminaux-ouverts"
        data-active={ouvert ? "true" : "false"}
        title={`Terminaux ouverts (${lignes.length}, ${enCours} en cours)`}
        aria-label="Terminaux ouverts"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        <Icon icon="solar:list-linear" width={14} height={14} />
      </button>
      {ouvert ? (
        <MenuFlottant ancre={bouton.current} onFermer={() => setOuvert(false)} etiquette="Terminaux ouverts" classe="acli-menu--terminaux" largeur={320}>
          <p className="acli-menu__titre">Terminaux ouverts ({lignes.length})</p>
          {lignes.map((l) => (
            <div key={l.id} className="acli-menu__ligne" data-terminal={l.id} data-en-cours={l.enCours ? "true" : "false"}>
              <button
                type="button"
                role="menuitem"
                className="acli-menu__item"
                data-action="aller"
                aria-current={l.actif ? "true" : undefined}
                title={`${l.titre} · ${l.etat}`}
                onClick={() => {
                  setOuvert(false);
                  onAller(l.id);
                }}
              >
                <Icon icon={l.agent ? "solar:cpu-bolt-linear" : "solar:command-linear"} width={13} height={13} />
                <span className="acli-menu__libelle">{l.titre}</span>
                <span className="acli-menu__detail">{l.etat}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="acli-menu__item acli-menu__reprendre"
                data-action="arreter"
                disabled={!l.enCours}
                title="Arrêter le processus"
                aria-label={`Arrêter ${l.titre}`}
                onClick={() => onArreter(l.id)}
              >
                <Icon icon="solar:stop-circle-linear" width={13} height={13} />
              </button>
            </div>
          ))}
          <div className="acli-menu__separateur" />
          <button type="button" role="menuitem" className="acli-menu__item" data-action="tout-arreter" disabled={enCours === 0} onClick={onToutArreter}>
            <Icon icon="solar:stop-circle-linear" width={13} height={13} />
            <span className="acli-menu__libelle">Tout arrêter ({enCours})</span>
          </button>
        </MenuFlottant>
      ) : null}
    </>
  );
}

export function BoutonPlusActions({
  scinde,
  peutScinder,
  onRechercher,
  onCopierTout,
  onScinder,
}: {
  scinde: boolean;
  peutScinder: boolean;
  onRechercher: () => void;
  onCopierTout: () => void;
  onScinder: () => void;
}) {
  const bouton = useRef<HTMLButtonElement | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const agir = (f: () => void) => () => {
    setOuvert(false);
    f();
  };
  return (
    <>
      <button
        ref={bouton}
        type="button"
        className="terminal-action"
        data-action="plus-terminal"
        data-active={ouvert ? "true" : "false"}
        title="Plus d'actions (rechercher, copier, scinder)"
        aria-label="Plus d'actions sur le terminal"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        <Icon icon="solar:menu-dots-linear" width={14} height={14} />
      </button>
      {ouvert ? (
        <MenuFlottant ancre={bouton.current} onFermer={() => setOuvert(false)} etiquette="Actions du terminal" classe="acli-menu--actions" largeur={250}>
          <button type="button" role="menuitem" className="acli-menu__item" data-action="rechercher" onClick={agir(onRechercher)} title={infoBulle("Rechercher dans le terminal", "rechercheTerminal")}>
            <Icon icon="solar:magnifer-linear" width={13} height={13} />
            <span className="acli-menu__libelle">Rechercher…</span>
          </button>
          <button type="button" role="menuitem" className="acli-menu__item" data-action="copier-tout" onClick={agir(onCopierTout)}>
            <Icon icon="solar:copy-linear" width={13} height={13} />
            <span className="acli-menu__libelle">Copier toute la sortie</span>
          </button>
          <button type="button" role="menuitem" className="acli-menu__item" data-action="scinder" disabled={!scinde && !peutScinder} onClick={agir(onScinder)}>
            <Icon icon={scinde ? "solar:square-linear" : "solar:widget-2-linear"} width={13} height={13} />
            <span className="acli-menu__libelle">{scinde ? "Ne plus scinder" : "Scinder le terminal"}</span>
          </button>
        </MenuFlottant>
      ) : null}
    </>
  );
}

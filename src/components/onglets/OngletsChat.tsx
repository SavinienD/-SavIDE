// axe:e14 — les conversations du chat en onglets, comme un navigateur.
//
// L'utilisateur : « des onglets façon navigateur pour la partie de droite chat » ;
// un onglet se détache pour venir devant, les autres restent à leur place.
// La conversation active est celle du volet où l'on écrit : un seul chat est
// monté à la fois, c'est la même règle qu'avant, simplement rendue visible.
import { useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { MIME_ONGLET_CHAT } from "../chat/colonnes";

export type OngletChat = {
  id: string;
  titre: string;
};

type Props = {
  onglets: OngletChat[];
  actif: string;
  /** Conversation actuellement dans une fenêtre détachée. */
  detache: string | null;
  onActiver: (id: string) => void;
  onFermer: (id: string) => void;
  /** axe:hotfix — plusieurs colonnes : le dernier onglet d'une colonne se ferme aussi. */
  fermable?: boolean;
  /** axe:hotfix — bouton « Fermer la colonne » (ses onglets vont à la voisine). */
  onFermerColonne?: () => void;
  onDetacher: (id: string) => void;
  onNouvelle: () => void;
  /** axe:e17b — un onglet d'une autre colonne est déposé ici (position). */
  onDeposer?: (id: string, position: number) => void;
};

export function OngletsChat({
  onglets,
  actif,
  detache,
  onActiver,
  onFermer,
  onDetacher,
  onNouvelle,
  onDeposer,
  fermable = false,
  onFermerColonne,
}: Props) {
  // axe:onglets-place — trop d'onglets pour la colonne : ils gardent leur taille
  // minimale (plus de croix posées sur l'onglet voisin) et la bande défile, à la
  // molette aussi ; l'onglet actif est toujours ramené dans la vue.
  const bandeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const bande = bandeRef.current;
    const onglet = bande?.querySelector<HTMLElement>('.onglets-chat__tab[data-active="true"]');
    if (!bande || !onglet) return;
    const b = bande.getBoundingClientRect();
    const o = onglet.getBoundingClientRect();
    if (o.left < b.left) bande.scrollLeft -= b.left - o.left + 4;
    else if (o.right > b.right) bande.scrollLeft += o.right - b.right + 4;
  }, [actif, onglets.length]);
  return (
    <div
      className="onglets-chat"
      role="tablist"
      aria-label="Conversations ouvertes"
      ref={bandeRef}
      onWheel={(event) => {
        const bande = bandeRef.current;
        if (!bande || bande.scrollWidth <= bande.clientWidth) return;
        if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) bande.scrollLeft += event.deltaY;
      }}
    >
      <div className="onglets-chat__list">
        {onglets.map((onglet, position) => {
          const estDetache = detache === onglet.id;
          const estActif = onglet.id === actif && !estDetache;
          return (
            <div
              key={onglet.id}
              role="tab"
              aria-selected={estActif}
              className="onglets-chat__tab"
              data-active={estActif ? "true" : "false"}
              data-detached={estDetache ? "true" : "false"}
              title={estDetache ? `${onglet.titre} — détachée, devant` : onglet.titre}
              // axe:e17b — glisser l'onglet vers une autre colonne (ou « + »).
              draggable={!estDetache}
              onDragStart={(event) => {
                event.dataTransfer.setData(MIME_ONGLET_CHAT, onglet.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (onDeposer && event.dataTransfer.types.includes(MIME_ONGLET_CHAT))
                  event.preventDefault();
              }}
              onDrop={(event) => {
                const id = event.dataTransfer.getData(MIME_ONGLET_CHAT);
                if (!id || !onDeposer) return;
                event.preventDefault();
                event.stopPropagation();
                onDeposer(id, position);
              }}
              onClick={() => {
                if (!estDetache) onActiver(onglet.id);
              }}
              onAuxClick={(event) => {
                // Clic du milieu : fermer l'onglet, comme dans un navigateur.
                if (event.button === 1) {
                  event.preventDefault();
                  onFermer(onglet.id);
                }
              }}
            >
              <Icon
                icon={estDetache ? "solar:pip-linear" : "solar:chat-round-dots-linear"}
                width={12}
                height={12}
              />
              <span className="onglets-chat__titre">{onglet.titre}</span>
              {estActif ? (
                <button
                  type="button"
                  className="onglets-chat__btn"
                  title="Détacher cette conversation dans une fenêtre"
                  aria-label={`Détacher ${onglet.titre}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onDetacher(onglet.id);
                  }}
                >
                  <Icon icon="solar:pip-linear" width={11} height={11} />
                </button>
              ) : null}
              {onglets.length > 1 || fermable ? (
                <button
                  type="button"
                  className="onglets-chat__btn"
                  title="Fermer l'onglet (la conversation est gardée dans la liste)"
                  aria-label={`Fermer l'onglet ${onglet.titre}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onFermer(onglet.id);
                  }}
                >
                  <Icon icon="solar:close-circle-linear" width={12} height={12} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="onglets-chat__new"
        title="Nouvelle conversation"
        aria-label="Nouvelle conversation"
        onClick={onNouvelle}
      >
        <Icon icon="solar:add-circle-linear" width={14} height={14} />
      </button>
      {onFermerColonne ? (
        <button
          type="button"
          className="onglets-chat__new onglets-chat__fermer-colonne"
          title="Fermer la colonne (ses onglets rejoignent la colonne voisine)"
          aria-label="Fermer la colonne"
          onClick={onFermerColonne}
        >
          <Icon icon="solar:close-circle-linear" width={14} height={14} />
        </button>
      ) : null}
    </div>
  );
}

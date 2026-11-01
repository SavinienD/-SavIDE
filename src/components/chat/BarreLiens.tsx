import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import { useMenuCheminChat } from "./MenuCheminChat";
import { LIBELLES_TYPES, ORDRE_TYPES, liensDeConversation, type LienConversation, type TypeLien } from "../../lib/liensConversation";
import type { ChatBlock } from "./stream";

const ICONES: Record<TypeLien, string> = {
  url: "solar:global-linear",
  code: "solar:code-file-linear",
  image: "solar:gallery-linear",
  video: "solar:videocamera-record-linear",
  pdf: "solar:document-text-linear",
  autre: "solar:file-linear",
};

/** Barre des liens de la conversation, dans l'en-tête du chat : un bouton avec le nombre de
 * liens ; la liste s'ouvre par-dessus le fil (aucun effet sur sa mise en page ni son défilement). */
export function BarreLiens({ blocks, onOpenFile }: { blocks: ChatBlock[]; onOpenFile: (path: string) => void }) {
  const liens = useMemo(() => liensDeConversation(blocks), [blocks]);
  const [ouvert, setOuvert] = useState(false);
  const [filtre, setFiltre] = useState<TypeLien | null>(null);
  const racine = useRef<HTMLDivElement>(null);
  const types = useMemo(() => ORDRE_TYPES.filter((t) => liens.some((l) => l.type === t)), [liens]);
  const visibles = filtre ? liens.filter((l) => l.type === filtre) : liens;

  useEffect(() => {
    if (filtre && !types.includes(filtre)) setFiltre(null);
  }, [filtre, types]);

  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: Event) => {
      if (!(e.target instanceof Element)) return;
      if (racine.current?.contains(e.target) || e.target.closest(".chat-path-menu")) return;
      setOuvert(false);
    };
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(".chat-path-menu")) setOuvert(false);
    };
    window.addEventListener("pointerdown", dehors, true);
    window.addEventListener("keydown", touche);
    return () => {
      window.removeEventListener("pointerdown", dehors, true);
      window.removeEventListener("keydown", touche);
    };
  }, [ouvert]);

  if (liens.length === 0) return null;
  return (
    <div className="chat-links" ref={racine}>
      <button
        type="button"
        className="chat-links__toggle"
        data-count={liens.length}
        data-open={ouvert}
        aria-expanded={ouvert}
        title="Liens de la conversation"
        onClick={() => setOuvert((v) => !v)}
      >
        <Icon icon="solar:link-linear" width={13} height={13} />
        <span>{liens.length}</span>
      </button>
      {ouvert && (
        <div className="chat-links__panel" role="dialog" aria-label="Liens de la conversation">
          {types.length > 1 && (
            <div className="chat-links__filters">
              <button type="button" className="chat-links__filter" data-type="tous" data-active={filtre === null} onClick={() => setFiltre(null)}>
                Tous <span>{liens.length}</span>
              </button>
              {types.map((t) => (
                <button key={t} type="button" className="chat-links__filter" data-type={t} data-active={filtre === t} onClick={() => setFiltre(t)}>
                  {LIBELLES_TYPES[t]} <span>{liens.filter((l) => l.type === t).length}</span>
                </button>
              ))}
            </div>
          )}
          <div className="chat-links__list">
            {visibles.map((l) => (
              <LigneLien key={`${l.genre}:${l.valeur}`} lien={l} onOpenFile={onOpenFile} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LigneLien({ lien, onOpenFile }: { lien: LienConversation; onOpenFile: (path: string) => void }) {
  const { onContextMenu, menu } = useMenuCheminChat(lien.valeur);
  const fichier = lien.genre === "fichier";
  return (
    <>
      <button
        type="button"
        className="chat-links__item"
        data-type={lien.type}
        data-lien={lien.valeur}
        title={lien.valeur}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (fichier) onOpenFile(lien.valeur);
          else void api.openExternalUrl(lien.valeur);
        }}
        onContextMenu={fichier ? onContextMenu : undefined}
      >
        <Icon icon={ICONES[lien.type]} width={13} height={13} />
        <span className="chat-links__name">{lien.nom}</span>
      </button>
      {fichier && menu}
    </>
  );
}

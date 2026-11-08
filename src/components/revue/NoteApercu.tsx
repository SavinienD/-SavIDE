// Revue des changements : crochet de l'aperçu Markdown. Du texte choisi dans l'aperçu fait
// apparaître « Noter » ; la note part dans les notes du dossier (même envoi que le diff).
// Rendu dans le conteneur de l'aperçu (EditorPane), il n'en change rien d'autre.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { correspond, RACCOURCIS } from "../../axe/raccourcis";
import { infoBulle } from "./infoBulle";
import { lignesDansSource } from "./apercuNotes";

export const EVENEMENT_NOTER = "revue:noter";

export type DemandeNote = { fichier: string; extrait: string; debut: number | null; fin: number | null };

type Position = { x: number; y: number };

export function NoteApercu({ fichier, source }: { fichier: string; source: string }) {
  const repereRef = useRef<HTMLSpanElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const sourceRef = useRef(source);
  sourceRef.current = source;

  const conteneur = () => repereRef.current?.parentElement ?? null;

  /** Texte choisi dans l'aperçu (null s'il n'y en a pas, ou s'il est ailleurs). */
  const choix = useCallback((): { texte: string; rect: DOMRect } | null => {
    const parent = conteneur();
    const sel = window.getSelection();
    if (!parent || !sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!parent.contains(range.commonAncestorContainer)) return null;
    const texte = sel.toString().trim();
    return texte ? { texte, rect: range.getBoundingClientRect() } : null;
  }, []);

  const noter = useCallback(() => {
    const c = choix();
    if (!c) return false;
    const lignes = lignesDansSource(sourceRef.current, c.texte);
    window.dispatchEvent(
      new CustomEvent<DemandeNote>(EVENEMENT_NOTER, {
        detail: { fichier, extrait: c.texte, debut: lignes?.debut ?? null, fin: lignes?.fin ?? null },
      }),
    );
    setPosition(null);
    return true;
  }, [choix, fichier]);

  useEffect(() => {
    const parent = conteneur();
    if (!parent) return;
    const maj = () => {
      const c = choix();
      setPosition(c ? { x: Math.min(c.rect.right, window.innerWidth - 96), y: Math.min(c.rect.bottom + 6, window.innerHeight - 36) } : null);
    };
    const cacher = () => setPosition(null);
    // Alt+N (touche du registre, modifiable) : noter le texte choisi ; sans choix, la touche passe.
    const touche = (e: KeyboardEvent) => {
      const r = RACCOURCIS.find((x) => x.id === "revueNoter");
      if (r && correspond(r, e) && noter()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    parent.addEventListener("mouseup", maj);
    parent.addEventListener("keyup", maj);
    parent.addEventListener("keydown", touche);
    parent.addEventListener("scroll", cacher, { passive: true });
    return () => {
      parent.removeEventListener("mouseup", maj);
      parent.removeEventListener("keyup", maj);
      parent.removeEventListener("keydown", touche);
      parent.removeEventListener("scroll", cacher);
    };
  }, [choix, noter]);

  return (
    <span ref={repereRef} className="revue-apercu-repere" aria-hidden={position ? undefined : "true"}>
      {position && typeof document !== "undefined"
        ? createPortal(
            <button
              type="button"
              className="revue-bouton revue-apercu-noter"
              style={{ left: position.x, top: position.y }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => noter()}
              title={infoBulle("Noter ce passage pour l'agent", "revueNoter")}
            >
              <Icon icon="solar:pen-linear" width={14} height={14} />
              <span>Noter</span>
            </button>,
            document.body,
          )
        : null}
    </span>
  );
}

// Worktrees — fenêtre de dialogue (même apparence que celles du panneau Git :
// classes git-panel__dialog-*). Échap ferme, Entrée valide (hors zone de texte).
import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dialogue({
  titre,
  description,
  children,
  libelle,
  onValider,
  onFermer,
  desactive = false,
  occupe = false,
  danger = false,
  annuler = "Annuler",
  large = false,
  classe,
}: {
  titre: string;
  description?: ReactNode;
  children?: ReactNode;
  libelle: string;
  onValider: () => void;
  onFermer: () => void;
  desactive?: boolean;
  occupe?: boolean;
  danger?: boolean;
  annuler?: string;
  large?: boolean;
  classe?: string;
}) {
  const panneau = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => {
      panneau.current?.querySelector<HTMLElement>("[data-autofocus], input, select, textarea, button")?.focus();
    }, 10);
    return () => window.clearTimeout(t);
  }, []);
  const touche = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!occupe) onFermer();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (!desactive && !occupe) onValider();
      }
    },
    [desactive, occupe, onFermer, onValider],
  );
  return createPortal(
    <div
      className="git-panel__dialog-backdrop wt-fond"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !occupe) onFermer();
      }}
    >
      <div
        ref={panneau}
        className={`git-panel__dialog wt-dialogue${large ? " wt-dialogue--large" : ""}${classe ? ` ${classe}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={titre}
        onKeyDown={touche}
      >
        <div className="git-panel__dialog-head">
          <h3 className="git-panel__dialog-title" title={titre}>{titre}</h3>
          {description ? <p className="git-panel__dialog-desc">{description}</p> : null}
        </div>
        {children ? <div className="git-panel__dialog-body">{children}</div> : null}
        <div className="git-panel__dialog-foot">
          <button type="button" className="git-panel__dialog-btn" onClick={onFermer} disabled={occupe}>
            {annuler}
          </button>
          <button
            type="button"
            className="git-panel__dialog-btn git-panel__dialog-btn--primary"
            data-danger={danger ? "true" : "false"}
            data-action="valider"
            onClick={onValider}
            disabled={desactive || occupe}
          >
            {occupe ? <span className="git-panel__spinner git-panel__spinner--inline" /> : null}
            <span>{libelle}</span>
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

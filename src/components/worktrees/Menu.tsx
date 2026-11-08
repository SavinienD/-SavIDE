// Worktrees — petit menu (ligne de la liste, groupe d'un dépôt) : au clavier,
// flèches haut / bas, Entrée, Échap ; se ferme au clic à côté.
import { useEffect, useRef, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

export type EntreeMenu = { cle: string; libelle: string; action: () => void; desactive?: boolean; danger?: boolean };

export function MenuFlottant({ x, y, entrees, onFermer }: { x: number; y: number; entrees: EntreeMenu[]; onFermer: () => void }) {
  const boite = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    boite.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const dehors = (e: MouseEvent) => {
      if (boite.current && !boite.current.contains(e.target as Node)) onFermer();
    };
    window.addEventListener("mousedown", dehors, true);
    return () => window.removeEventListener("mousedown", dehors, true);
  }, [onFermer]);
  const touche = (e: KeyboardEvent<HTMLDivElement>) => {
    const boutons = [...(boite.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const i = boutons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onFermer();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = boutons.length;
      if (n) boutons[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n].focus();
    } else if (e.key === "Tab") {
      onFermer();
    }
  };
  // Le menu reste dans la fenêtre (220 px de large, 30 px par entrée).
  const largeur = 220;
  const hauteur = entrees.length * 30 + 8;
  const gauche = Math.max(4, Math.min(x, window.innerWidth - largeur - 4));
  const haut = Math.max(4, Math.min(y, window.innerHeight - hauteur - 4));
  return createPortal(
    <div ref={boite} className="wt-menu" role="menu" style={{ left: gauche, top: haut, width: largeur }} onKeyDown={touche}>
      {entrees.map((e) => (
        <button
          key={e.cle}
          type="button"
          role="menuitem"
          className="wt-menu__entree"
          data-action={e.cle}
          data-danger={e.danger ? "true" : "false"}
          disabled={e.desactive}
          onClick={() => {
            onFermer();
            e.action();
          }}
        >
          {e.libelle}
        </button>
      ))}
    </div>,
    document.body,
  );
}

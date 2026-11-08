// Menu flottant des terminaux (Nouvel agent, terminaux ouverts, commandes enregistrées) :
// ouvert dans un portail en position fixe (jamais coupé par le panneau), sous le bouton
// ou au-dessus s'il manque de place ; Échap ou un clic dehors le ferme ; flèches haut/bas
// entre les éléments [role=menuitem].
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./agents-cli.css";

type Props = {
  ancre: HTMLElement | null;
  onFermer: () => void;
  children: ReactNode;
  /** Largeur souhaitée (px), bornée par la fenêtre. */
  largeur?: number;
  etiquette: string;
  classe?: string;
};

const MARGE = 8;

export function MenuFlottant({ ancre, onFermer, children, largeur = 280, etiquette, classe }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; maxHeight: number; width: number } | null>(null);
  const fermerRef = useRef(onFermer);
  fermerRef.current = onFermer;

  useLayoutEffect(() => {
    if (!ancre) return;
    const placer = () => {
      const r = ancre.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(largeur, vw - 2 * MARGE);
      const left = Math.max(MARGE, Math.min(r.right - width, vw - width - MARGE));
      const dessous = vh - r.bottom - MARGE;
      const dessus = r.top - MARGE;
      if (dessous >= 220 || dessous >= dessus) setPos({ left, top: r.bottom + 4, maxHeight: Math.max(120, dessous - 4), width });
      else setPos({ left, bottom: vh - r.top + 4, maxHeight: Math.max(120, dessus - 4), width });
    };
    placer();
    window.addEventListener("resize", placer);
    return () => window.removeEventListener("resize", placer);
  }, [ancre, largeur]);

  useEffect(() => {
    const dehors = (e: MouseEvent) => {
      const cible = e.target as Node | null;
      if (ref.current?.contains(cible) || ancre?.contains(cible)) return;
      fermerRef.current();
    };
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        fermerRef.current();
        ancre?.focus();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[role=menuitem]:not(:disabled)") ?? []);
      if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      const suivant = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[i < 0 ? 0 : suivant].focus();
    };
    document.addEventListener("mousedown", dehors, true);
    document.addEventListener("keydown", touche, true);
    return () => {
      document.removeEventListener("mousedown", dehors, true);
      document.removeEventListener("keydown", touche, true);
    };
  }, [ancre]);

  useEffect(() => {
    if (!pos) return;
    const premier = ref.current?.querySelector<HTMLElement>("[role=menuitem]:not(:disabled), input, textarea");
    premier?.focus();
    // Une seule fois, à l'ouverture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos === null]);

  if (!ancre || !pos) return null;
  return createPortal(
    <div
      ref={ref}
      className={`acli-menu${classe ? ` ${classe}` : ""}`}
      role="menu"
      aria-label={etiquette}
      style={{ left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight, width: pos.width }}
    >
      {children}
    </div>,
    document.body,
  );
}

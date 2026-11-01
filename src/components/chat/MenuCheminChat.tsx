import { createContext, useContext, useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";

/** Actions du clic droit sur un chemin de fichier du chat. */
export type ActionsCheminChat = {
  /** Ouvre le volet explorateur et y sélectionne le fichier (absent : entrée masquée). */
  afficher?: (chemin: string) => void;
  /** Copie le chemin complet ou relatif. */
  copier: (chemin: string, genre: "complet" | "relatif") => void;
};

export const ActionsCheminChatContext = createContext<ActionsCheminChat | null>(null);

type Ouvert = { chemin: string; x: number; y: number };

/** Clic droit sur un lien de fichier : petit menu (même style que celui de l'explorateur),
 * rendu dans <body> pour ne rien changer à la mise en page (et au défilement) du chat. */
export function useMenuCheminChat(chemin: string) {
  const actions = useContext(ActionsCheminChatContext);
  const [ouvert, setOuvert] = useState<Ouvert | null>(null);

  useEffect(() => {
    if (!ouvert) return;
    const fermer = () => setOuvert(null);
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") fermer();
    };
    const dehors = (e: Event) => {
      if (!(e.target instanceof Element) || !e.target.closest(".chat-path-menu")) fermer();
    };
    window.addEventListener("pointerdown", dehors, true);
    window.addEventListener("keydown", touche);
    window.addEventListener("resize", fermer);
    window.addEventListener("blur", fermer);
    return () => {
      window.removeEventListener("pointerdown", dehors, true);
      window.removeEventListener("keydown", touche);
      window.removeEventListener("resize", fermer);
      window.removeEventListener("blur", fermer);
    };
  }, [ouvert]);

  const onContextMenu = (event: ReactMouseEvent) => {
    if (!actions) return;
    event.preventDefault();
    event.stopPropagation();
    const largeur = 230;
    const hauteur = 112;
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - largeur - 8));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - hauteur - 8));
    setOuvert({ chemin, x, y });
  };

  const faire = (action: () => void) => {
    setOuvert(null);
    action();
  };

  const menu =
    ouvert && actions && typeof document !== "undefined"
      ? createPortal(
          <div
            className="tree-menu chat-path-menu"
            role="menu"
            style={{ left: ouvert.x, top: ouvert.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {actions.afficher && (
              <Entree
                icon="solar:folder-open-linear"
                label="Afficher dans l'explorateur"
                onClick={() => faire(() => actions.afficher?.(ouvert.chemin))}
              />
            )}
            <Entree
              icon="solar:link-linear"
              label="Copier le chemin"
              onClick={() => faire(() => actions.copier(ouvert.chemin, "complet"))}
            />
            <Entree
              icon="solar:branching-paths-down-linear"
              label="Copier le chemin relatif"
              onClick={() => faire(() => actions.copier(ouvert.chemin, "relatif"))}
            />
          </div>,
          document.body,
        )
      : null;

  return { onContextMenu, menu };
}

function Entree({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button type="button" className="tree-menu__item" data-danger="false" role="menuitem" onClick={onClick}>
      <Icon icon={icon} width={14} height={14} />
      <span>{label}</span>
    </button>
  );
}

// Carte « Dossier introuvable » de l'accueil : le dossier d'un récent (ou de
// Ctrl+1…9, ou d'une conversation) n'est plus à son chemin et la recherche ne l'a pas trouvé.
import { useEffect, useRef } from "react";
import { Icon } from "@iconify/react";
import { displayPath } from "./freechat/freechatApi";
import "./dossier-introuvable.css";

type Props = {
  chemin: string;
  nom: string;
  /** Recherche en cours (premier essai ou « Rechercher à nouveau »). */
  recherche: boolean;
  /** Message d'erreur après un choix manuel refusé. */
  erreur?: string | null;
  onRechercher: () => void;
  onChoisir: () => void;
  onRetirer: () => void;
  onFermer: () => void;
};

export function DossierIntrouvable({ chemin, nom, recherche, erreur, onRechercher, onChoisir, onRetirer, onFermer }: Props) {
  // Carte au centre de la fenêtre, au-dessus de l'accueil (visible même accueil défilé ou petite
  // fenêtre) ; la barre de titre reste libre. Échap la ferme ; le bouton principal prend le focus.
  const principal = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recherche) principal.current?.focus();
  }, [chemin, recherche]);
  useEffect(() => {
    const touche = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFermer();
    };
    window.addEventListener("keydown", touche);
    return () => window.removeEventListener("keydown", touche);
  }, [onFermer]);
  return (
    <div className="dossier-introuvable__fond" role="presentation">
    <section className="dossier-introuvable" role="alertdialog" aria-modal="true" aria-label="Dossier introuvable" data-dossier-introuvable={chemin}>
      <div className="dossier-introuvable__tete">
        <span className="dossier-introuvable__icone" aria-hidden="true">
          {recherche ? (
            <span className="welcome__recent-spinner" />
          ) : (
            <Icon icon="solar:folder-bold-duotone" width={22} height={22} />
          )}
        </span>
        <span className="dossier-introuvable__texte">
          <span className="dossier-introuvable__titre">{recherche ? `Recherche de « ${nom} »…` : "Dossier introuvable"}</span>
          <span className="dossier-introuvable__chemin" title={chemin}>{displayPath(chemin)}</span>
          <span className="dossier-introuvable__aide">
            {recherche
              ? "Le dossier n'est plus à cet emplacement : recherche autour de l'ancien emplacement et dans vos dossiers habituels."
              : "Il a peut-être été renommé, déplacé sur un autre disque ou supprimé. Vos conversations sont conservées."}
          </span>
          {erreur && <span className="dossier-introuvable__erreur">{erreur}</span>}
        </span>
        <button type="button" className="dossier-introuvable__fermer" aria-label="Fermer" title="Fermer" onClick={onFermer}>
          <Icon icon="solar:close-circle-linear" width={16} height={16} />
        </button>
      </div>
      <div className="dossier-introuvable__actions">
        <button type="button" className="axc-btn" data-action="rechercher" disabled={recherche} onClick={onRechercher}>
          Rechercher à nouveau
        </button>
        <button ref={principal} type="button" className="axc-btn axc-btn--primary" data-action="choisir" disabled={recherche} onClick={onChoisir}>
          Choisir le nouvel emplacement
        </button>
        <button type="button" className="axc-btn" data-action="retirer" onClick={onRetirer}>
          Retirer de la liste
        </button>
      </div>
    </section>
    </div>
  );
}

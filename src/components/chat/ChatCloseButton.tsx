// axe:e17b — le ✕ du chat.
//
// Le bouton X n'est affiché que sur un chat détaché et sert à archiver ou
// ré-ancrer la conversation. Dans la colonne normale il n'existe pas : l'ancien
// ✕ du header ne faisait rien (ou disparaissait sans archiver), d'où ce
// composant unique. Archiver demande toujours une confirmation explicite.
import { useState } from "react";

type Props = {
  conversationId: string;
  /** L'archive n'existe que sur un espace (cloud) ; en local on ne l'invente pas. */
  peutArchiver: boolean;
  onReancrer: () => void;
  onArchiver: (id: string) => Promise<void> | void;
  /** Injectable pour les tests ; window.confirm par défaut. */
  confirmer?: (message: string) => boolean;
};

export function ChatCloseButton({
  conversationId,
  peutArchiver,
  onReancrer,
  onArchiver,
  confirmer = (m) => window.confirm(m),
}: Props) {
  const [menu, setMenu] = useState(false);
  return (
    <span className="chat-close-hote">
      <button
        type="button"
        className="chat-close fenetre-onglet__btn"
        title="Fermer : ré-ancrer ou archiver la conversation"
        aria-label="Fermer la conversation détachée"
        aria-expanded={menu}
        onClick={() => setMenu((v) => !v)}
      >
        ✕
      </button>
      {menu ? (
        <span className="chat-close__menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              onReancrer();
            }}
          >
            Ré-ancrer
          </button>
          {peutArchiver ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(false);
                if (confirmer("Archiver cette conversation ? Elle quittera sa colonne.")) {
                  void onArchiver(conversationId);
                } else {
                  onReancrer();
                }
              }}
            >
              Archiver…
            </button>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

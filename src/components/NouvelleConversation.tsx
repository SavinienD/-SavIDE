// axe:e13 — le champ de creation d'une conversation. Le nom est demande a la
// creation (et exige) : c'est ce qui permet de retrouver la conversation dans
// la liste, la recherche et les archives. Meme champ dans l'ecran IDE et dans
// la vue « conversation libre ».
import { useState } from "react";

type Props = {
  busy?: boolean;
  onCancel: () => void;
  onCreate: (title: string) => void;
};

export function NouvelleConversation({ busy, onCancel, onCreate }: Props) {
  const [titre, setTitre] = useState("");
  const nom = titre.trim();

  return (
    <div className="conv-create">
      <input
        className="conv-create__input"
        autoFocus
        value={titre}
        placeholder="Nom de la conversation"
        spellCheck={false}
        onChange={(event) => setTitre(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && nom) onCreate(nom);
          if (event.key === "Escape") onCancel();
        }}
      />
      <div className="conv-create__actions">
        <button
          type="button"
          className="conv-create__ok"
          disabled={!nom || !!busy}
          onClick={() => onCreate(nom)}
        >
          Créer
        </button>
        <button type="button" className="conv-create__no" onClick={onCancel}>
          Annuler
        </button>
      </div>
    </div>
  );
}

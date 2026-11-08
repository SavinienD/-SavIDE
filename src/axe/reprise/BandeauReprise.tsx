// Bandeau « Reprise automatique à HH:MM » au-dessus du compositeur : reprise prévue de la
// conversation après une limite d'abonnement, et celles de ses sous-agents ; chacune s'annule.
// Données : surveillanceReprise.ts.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { reprisesDe, texteBandeau } from "./repriseAuto";
import { abonnerReprises, annulerReprise, reprisesPrevues } from "./surveillanceReprise";
import "./reprise.css";

export function BandeauReprise({ conversationId }: { conversationId: string }) {
  const [file, setFile] = useState(() => [...reprisesPrevues()]);
  useEffect(() => abonnerReprises(() => setFile([...reprisesPrevues()])), []);
  const miennes = reprisesDe(file, conversationId);
  if (miennes.length === 0) return null;
  return (
    <div className="bandeau-reprise" role="status" data-testid="bandeau-reprise">
      {miennes.map((r) => {
        const texte = texteBandeau(r, conversationId);
        return (
        <div key={r.sessionId} className="bandeau-reprise__ligne" data-enfant={r.sessionId !== conversationId ? "true" : "false"}>
          <Icon icon="solar:clock-circle-linear" width={14} height={14} aria-hidden />
          <span className="bandeau-reprise__texte" title={texte}>
            {texte}
          </span>
          <button
            type="button"
            className="bandeau-reprise__annuler"
            onClick={() => annulerReprise(r.sessionId)}
            aria-label={r.sessionId === conversationId ? "Annuler la reprise automatique" : `Annuler la reprise du sous-agent ${r.nom}`}
          >
            Annuler
          </button>
        </div>
        );
      })}
    </div>
  );
}

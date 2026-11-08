// Réglages > REPL : « Demander avant d'agir » par défaut (nouvelles
// conversations et celles sans réglage propre). Défaut d'origine : l'agent agit seul.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModeEffectif } from "../../lib/validationActions";
import "./repl.css";

const appel = (method: string, params: unknown) =>
  invoke<ModeEffectif>("daemon_call", { input: { method, params, connection: null } });

export function ValidationDefaut() {
  const [mode, setMode] = useState<ModeEffectif | null>(null);
  const [statut, setStatut] = useState<string | null>(null);

  useEffect(() => {
    appel("approbation.mode", {})
      .then(setMode)
      .catch((e) => setStatut(String(e)));
  }, []);

  return (
    <section className="axe-repl__card axe-validation__defaut" data-testid="validation-defaut">
      <label className="axe-repl__row">
        <input
          type="checkbox"
          disabled={!mode}
          checked={mode?.defaut === "demander"}
          onChange={(e) => {
            const voulu = e.target.checked ? "demander" : "autonome";
            appel("approbation.regler", { mode: voulu })
              .then((m) => {
                setMode(m);
                setStatut("Enregistré");
              })
              .catch((err) => setStatut(String(err)));
          }}
        />
        <span>Demander avant d'agir (par défaut) : chaque cellule de l'agent attend votre accord</span>
      </label>
      <p className="axe-repl__muted">
        Se règle aussi par conversation, avec le bouton bouclier sous la zone de saisie. Les sous-agents suivent leur conversation.
        {statut ? ` ${statut}.` : ""}
      </p>
    </section>
  );
}

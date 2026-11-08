// bouton du compositeur : « Demander avant d'agir » pour CETTE
// conversation (sinon le réglage par défaut des Réglages > REPL, ou celui du parent).
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { abonner, basculer, libelleMode, versionDemandes, type ModeEffectif } from "../../lib/validationActions";

type Props = { workspacePath: string; conversationId: string };

export function BoutonValidation({ workspacePath, conversationId }: Props) {
  const [mode, setMode] = useState<ModeEffectif | null>(null);
  const [occupe, setOccupe] = useState(false);
  // Une réponse « Toujours » change le réglage : relu à chaque demande reçue ou close.
  const version = useSyncExternalStore(abonner, versionDemandes);
  const connexion = cloudConnectionFromPath(workspacePath);

  const lire = useCallback(() => {
    if (!conversationId) return;
    invoke<ModeEffectif>("daemon_call", { input: { method: "approbation.mode", params: { sessionId: conversationId }, connection: connexion } })
      .then(setMode)
      .catch(() => setMode(null));
  }, [conversationId, connexion]);

  useEffect(() => {
    lire();
  }, [lire, version]);

  if (!conversationId) return null;
  const actif = mode?.mode === "demander";
  const libelle = libelleMode(mode);
  return (
    <button
      type="button"
      className="composer__iconbtn axe-validation__bouton"
      data-active={actif ? "true" : "false"}
      aria-pressed={actif}
      aria-label={libelle}
      disabled={occupe}
      onClick={() => {
        setOccupe(true);
        invoke<ModeEffectif>("daemon_call", {
          input: { method: "approbation.regler", params: { sessionId: conversationId, mode: basculer(mode) }, connection: connexion },
        })
          .then(setMode)
          .catch(() => undefined)
          .finally(() => setOccupe(false));
      }}
    >
      <Icon icon={actif ? "solar:shield-warning-linear" : "solar:shield-check-linear"} width={16} height={16} />
      <span className="composer__iconbtn-tip" role="tooltip" aria-hidden="true">
        {libelle}
      </span>
    </button>
  );
}

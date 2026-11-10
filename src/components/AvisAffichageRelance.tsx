// Avis discret posé en bas de la fenêtre après un rechargement automatique de la page.
import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { abonnerAvis, avisVisible, DUREE_AVIS_MS, fermerAvis } from "../lib/avisAffichage";

const boite: CSSProperties = {
  position: "fixed", left: "50%", bottom: 24, transform: "translateX(-50%)", zIndex: 2147483000,
  display: "flex", alignItems: "center", gap: 12, maxWidth: "min(560px, calc(100vw - 32px))",
  padding: "10px 14px", borderRadius: 8, border: "1px solid rgba(232, 233, 236, 0.14)",
  background: "var(--bg-2, #141518)", color: "var(--text-0, #e8e9ec)", fontSize: 13, lineHeight: 1.4,
  boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
};
const bouton: CSSProperties = {
  flex: "none", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(232, 233, 236, 0.14)",
  background: "transparent", color: "inherit", cursor: "pointer", font: "inherit",
};

export function AvisAffichageRelance() {
  const visible = useSyncExternalStore(abonnerAvis, avisVisible, avisVisible);
  useEffect(() => {
    if (!visible) return;
    const id = window.setTimeout(fermerAvis, DUREE_AVIS_MS);
    return () => window.clearTimeout(id);
  }, [visible]);
  if (!visible) return null;
  return (
    <div role="status" data-avis-affichage-relance style={boite}>
      <div>
        <strong>L'affichage a été relancé.</strong>{" "}
        Le moteur d'affichage de la fenêtre s'était arrêté ; la page a été rechargée et l'écran rouvert.
      </div>
      <button type="button" style={bouton} onClick={fermerAvis}>
        Fermer
      </button>
    </div>
  );
}

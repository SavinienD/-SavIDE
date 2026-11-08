// premier lancement : si des serveurs MCP sont déclarés pour Claude
// Code, Codex, Cursor ou VS Code, l'appli propose UNE fois de les reprendre.
// « Choisir… » ouvre Réglages > MCP sur la boîte d'import ; « Plus tard » ne revient pas.
import { useEffect, useState } from "react";
import { interopApi } from "../../lib/interopApi";
import { aProposer, demanderImportMcp, noterProposition, outilsTrouves, propositionFaite } from "../../lib/importMcp";
import { ouvrirReglages } from "../chat/SlashCommands";
import "./interop.css";

const stockage = () => (typeof window === "undefined" ? null : window.localStorage);

export function PropositionMcp({ workspacePath }: { workspacePath: string }) {
  const [texte, setTexte] = useState<string | null>(null);

  useEffect(() => {
    if (propositionFaite(stockage())) return;
    let vivant = true;
    const minuterie = window.setTimeout(() => {
      interopApi
        .mcpScanner(workspacePath)
        .then((liste) => {
          const n = aProposer(liste);
          if (!vivant || n === 0) return;
          setTexte(`${n} serveur${n > 1 ? "s" : ""} MCP de ${outilsTrouves(liste)} ${n > 1 ? "peuvent" : "peut"} être ajouté${n > 1 ? "s" : ""} à vos serveurs.`);
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      vivant = false;
      window.clearTimeout(minuterie);
    };
  }, [workspacePath]);

  if (!texte) return null;
  const repondre = (reponse: "choisir" | "plus-tard") => {
    noterProposition(stockage(), reponse);
    setTexte(null);
    if (reponse === "choisir") {
      demanderImportMcp();
      ouvrirReglages("mcp");
    }
  };
  return (
    <div className="axe-interop__proposition" role="dialog" aria-labelledby="axe-interop-prop-titre" onKeyDown={(e) => e.key === "Escape" && repondre("plus-tard")}>
      <strong id="axe-interop-prop-titre">Serveurs MCP trouvés</strong>
      <p>{texte}</p>
      <div className="axe-harness__actions">
        <button type="button" className="axe-harness__btn axe-harness__btn--primary" data-action="proposition-choisir" onClick={() => repondre("choisir")}>
          Choisir…
        </button>
        <button type="button" className="axe-harness__btn" data-action="proposition-plus-tard" onClick={() => repondre("plus-tard")}>
          Plus tard
        </button>
      </div>
    </div>
  );
}

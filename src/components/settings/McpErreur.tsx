// mcp-guide — erreur d'un serveur MCP expliquée (titre, conseil) avec le journal brut
// (secrets masqués) dépliable et copiable ; résultat du bouton « Tester ».
import { useState } from "react";
import { Icon } from "@iconify/react";
import { expliquerErreurMcp, type ErreurExpliquee } from "../../axe/mcpGuide";
import type { McpServerProbe } from "../../types";

export function ErreurMcp({ erreur }: { erreur: ErreurExpliquee }) {
  const [copie, setCopie] = useState(false);
  const copier = async () => {
    try {
      await navigator.clipboard.writeText(erreur.journal);
      setCopie(true);
      window.setTimeout(() => setCopie(false), 1500);
    } catch {
      /* presse-papiers indisponible */
    }
  };
  return (
    <div className="settings-pane__mcp-erreur" role="status">
      <div className="settings-pane__mcp-erreur-resume">
        <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
        <strong>{erreur.titre}</strong>
      </div>
      <p className="settings-pane__mcp-erreur-conseil">{erreur.conseil}</p>
      {erreur.journal.trim() && (
        <details className="settings-pane__mcp-journal">
          <summary>Journal du serveur</summary>
          <pre>{erreur.journal}</pre>
          <button type="button" className="settings-pane__btn settings-pane__mcp-journal-copier" onClick={() => void copier()}>
            <Icon icon={copie ? "solar:check-circle-linear" : "solar:copy-linear"} width={13} height={13} />
            <span>{copie ? "Copié" : "Copier le journal"}</span>
          </button>
        </details>
      )}
    </div>
  );
}

export function ResultatTestMcp({ probe }: { probe: McpServerProbe }) {
  if (probe.ok) {
    const noms = probe.tools.map((tool) => tool.title || tool.name);
    return (
      <div className="settings-pane__mcp-test" data-tone="ok" role="status">
        <strong>
          Connecté · {probe.tools.length} outil{probe.tools.length > 1 ? "s" : ""}
        </strong>
        {noms.length > 0 && (
          <span className="settings-pane__mcp-test-outils">
            {noms.slice(0, 8).join(", ")}
            {noms.length > 8 ? `… (+${noms.length - 8})` : ""}
          </span>
        )}
      </div>
    );
  }
  const erreur = expliquerErreurMcp(probe.error, { transport: probe.transport, authRequired: probe.authRequired });
  if (probe.authRequired && erreur) {
    return (
      <div className="settings-pane__mcp-test" data-tone="auth" role="status">
        <strong>{erreur.titre}</strong>
        <span>Ajoutez le serveur, puis « Se connecter » ouvrira le navigateur (ou indiquez un jeton).</span>
      </div>
    );
  }
  return erreur ? <ErreurMcp erreur={erreur} /> : null;
}

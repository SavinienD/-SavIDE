// Réglages > Agents en ligne de commande : agents installés ou absents (page
// d'installation), arguments de lancement, exécutable, autonomie complète.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import {
  argsInteractifs,
  autonomieDisponible,
  enregistrerAgentsCli,
  lireAgentsCli,
  ligneAffichee,
  reglagesDepuis,
  type AgentCli,
  type ReglageAgentCli,
} from "./catalogueCli";
import "./agents-cli.css";

/** Bouton du menu des Réglages (mêmes classes que les autres sections). */
export function BoutonReglagesAgentsCli({ actif, onClick }: { actif: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="settings-pane__nav-item"
      data-section="agentsCli"
      data-active={actif ? "true" : "false"}
      onClick={onClick}
      title="Agents en ligne de commande"
    >
      <Icon icon="solar:programming-linear" width={15} height={15} className="settings-pane__nav-icon" />
      <span className="settings-pane__nav-label">Agents CLI</span>
      <span className="settings-pane__nav-count" />
    </button>
  );
}

export function ReglagesAgentsCli({ apres }: { apres?: React.ReactNode }) {
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [enregistres, setEnregistres] = useState("");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState(false);

  const recevoir = useCallback((liste: AgentCli[]) => {
    setAgents(liste);
    setEnregistres(JSON.stringify(reglagesDepuis(liste)));
    setErreur("");
  }, []);

  const actualiser = useCallback(() => {
    setOccupe(true);
    lireAgentsCli()
      .then(recevoir)
      .catch((e) => setErreur(String(e)))
      .finally(() => setOccupe(false));
  }, [recevoir]);
  useEffect(actualiser, [actualiser]);

  const modifier = (id: string, patch: Partial<ReglageAgentCli>) =>
    setAgents((liste) => liste?.map((a) => (a.id === id ? { ...a, reglage: { ...a.reglage, ...patch } } : a)) ?? liste);

  const modifie = agents !== null && JSON.stringify(reglagesDepuis(agents)) !== enregistres;
  const enregistrer = () => {
    if (!agents) return;
    setOccupe(true);
    enregistrerAgentsCli(reglagesDepuis(agents))
      .then(recevoir)
      .catch((e) => setErreur(String(e)))
      .finally(() => setOccupe(false));
  };

  const installes = agents?.filter((a) => a.installe) ?? [];
  const absents = agents?.filter((a) => !a.installe) ?? [];
  return (
    <div className="axe-appearance acli-reglages">
      <header>
        <h2 title="Agents en ligne de commande">Agents en ligne de commande</h2>
        <p className="axe-appearance__hint">
          Claude Code, Codex, Gemini CLI… lancés dans un terminal de l'IDE avec votre propre compte
          (menu « Nouvel agent » des terminaux). Par défaut, chaque agent demande avant d'agir.
        </p>
      </header>
      <div className="acli-reglages__actions">
        <button type="button" className="axe-appearance__button" onClick={actualiser} disabled={occupe} title="Chercher à nouveau les agents installés">
          Actualiser
        </button>
        <button type="button" className="axe-appearance__button acli-reglages__enregistrer" onClick={enregistrer} disabled={!modifie || occupe}>
          Enregistrer
        </button>
      </div>
      {erreur ? <p className="acli-erreur" role="alert">{erreur}</p> : null}
      {agents === null && !erreur ? <p className="axe-appearance__hint">Recherche des agents installés…</p> : null}
      {agents !== null ? (
        <>
          <section className="axe-appearance__block" data-liste="installes">
            <h3 title="Agents installés">Installés ({installes.length})</h3>
            {installes.length === 0 ? <p className="axe-appearance__hint">Aucun agent trouvé sur ce poste.</p> : null}
            {installes.map((a) => <LigneAgent key={a.id} agent={a} onChange={(p) => modifier(a.id, p)} />)}
          </section>
          <section className="axe-appearance__block" data-liste="absents">
            <h3 title="Agents absents de ce poste">Absents ({absents.length})</h3>
            {absents.map((a) => <LigneAgent key={a.id} agent={a} onChange={(p) => modifier(a.id, p)} />)}
          </section>
        </>
      ) : null}
      {apres}
    </div>
  );
}

function LigneAgent({ agent: a, onChange }: { agent: AgentCli; onChange: (p: Partial<ReglageAgentCli>) => void }) {
  const r = a.reglage;
  const ligne = ligneAffichee(a.commande, argsInteractifs(a, r));
  return (
    <details className="acli-agent" data-agent={a.id} data-installe={a.installe ? "oui" : "non"}>
      <summary className="acli-agent__resume" title={a.nom}>
        <span className="acli-agent__nom" title={a.nom}>{a.nom}</span>
        {r.autonomie ? <span className="acli-pastille" data-genre="autonomie" title="Autonomie complète">autonome</span> : null}
        {!a.installe ? <span className="acli-pastille" data-genre="absent">absent</span> : null}
      </summary>
      <div className="acli-agent__corps">
        {a.installe ? (
          <p className="acli-agent__chemin" title={a.chemin ?? ""}>{a.chemin}</p>
        ) : (
          <button type="button" className="axe-appearance__button acli-agent__installer" onClick={() => void api.openExternalUrl(a.installation)} title={a.installation}>
            Page d'installation
          </button>
        )}
        {autonomieDisponible(a) ? (
          <label className="acli-case">
            <input type="checkbox" checked={r.autonomie} onChange={(e) => onChange({ autonomie: e.target.checked })} />
            <span>Autonomie complète</span>
          </label>
        ) : (
          <p className="axe-appearance__hint">Aucun mode d'autonomie complète connu pour cet agent.</p>
        )}
        {r.autonomie ? (
          <p className="acli-avertissement" role="note">
            L'agent modifiera des fichiers et lancera des commandes sans rien demander. Lancez-le de
            préférence dans un nouvel arbre de travail et relisez ses changements.
          </p>
        ) : null}
        <label className="acli-champ">
          <span>Arguments de lancement</span>
          <input
            type="text"
            spellCheck={false}
            value={r.args ?? a.args.join(" ")}
            placeholder="aucun"
            onChange={(e) => onChange({ args: e.target.value })}
          />
        </label>
        <label className="acli-champ">
          <span>Exécutable</span>
          <input
            type="text"
            spellCheck={false}
            value={r.chemin ?? ""}
            placeholder={`${a.commande} (trouvé automatiquement)`}
            onChange={(e) => onChange({ chemin: e.target.value })}
          />
        </label>
        <p className="acli-agent__ligne" title={ligne}>
          <code>{ligne}</code>
        </p>
      </div>
    </details>
  );
}

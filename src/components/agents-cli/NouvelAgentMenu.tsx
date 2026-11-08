// « Nouvel agent » de la barre des terminaux : choisir un agent installé et le lancer
// dans le dossier courant ou dans un nouvel arbre de travail (git worktree).
import { useState, useRef } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import { ouvrirReglages } from "../chat/SlashCommands";
import { MenuFlottant } from "./MenuFlottant";
import { brancheAgent, lireAgentsCli, type AgentCli } from "./catalogueCli";

export type LancementAgent = {
  cli: string;
  nom: string;
  dossier: string;
  branche?: string;
  /** L'agent sait reprendre une session (bouton « Reprendre une session »). */
  reprise?: boolean;
  invites?: string[];
  /** Lancer avec sa commande de reprise de session. */
  reprendre?: boolean;
};

export function BoutonNouvelAgent({ workspacePath, onLancer }: { workspacePath: string; onLancer: (l: LancementAgent) => void }) {
  const boutonRef = useRef<HTMLButtonElement | null>(null);
  const [ouvert, setOuvert] = useState(false);
  const [agents, setAgents] = useState<AgentCli[] | null>(null);
  const [ou, setOu] = useState<"dossier" | "arbre">("dossier");
  const [erreur, setErreur] = useState("");
  const [occupe, setOccupe] = useState<string | null>(null);

  const ouvrir = () => {
    if (ouvert) {
      setOuvert(false);
      return;
    }
    setOuvert(true);
    setErreur("");
    lireAgentsCli()
      .then(setAgents)
      .catch((e) => {
        setAgents([]);
        setErreur(String(e));
      });
  };

  const lancer = (a: AgentCli, reprendre = false) => {
    const base = { cli: a.id, nom: a.nom, reprise: !!a.reprise, invites: a.invites, reprendre };
    if (ou === "dossier" || reprendre) {
      setOuvert(false);
      onLancer({ ...base, dossier: workspacePath });
      return;
    }
    setOccupe(a.id);
    setErreur("");
    api
      .gitCreateWorktree(workspacePath, brancheAgent(a.id, new Date()), null, false)
      .then((cree) => {
        setOuvert(false);
        onLancer({ ...base, dossier: cree.worktreePath, branche: cree.branch });
      })
      .catch((e) => setErreur(`Arbre de travail impossible : ${String(e)}`))
      .finally(() => setOccupe(null));
  };

  const installes = agents?.filter((a) => a.installe) ?? [];
  return (
    <>
      <button
        ref={boutonRef}
        type="button"
        className="terminal-action"
        data-action="nouvel-agent"
        data-active={ouvert ? "true" : "false"}
        onClick={ouvrir}
        title="Nouvel agent (Claude Code, Codex, Gemini CLI…)"
        aria-label="Nouvel agent"
        aria-haspopup="menu"
        aria-expanded={ouvert}
      >
        <Icon icon="solar:cpu-bolt-linear" width={14} height={14} />
      </button>
      {ouvert ? (
        <MenuFlottant ancre={boutonRef.current} onFermer={() => setOuvert(false)} etiquette="Nouvel agent" classe="acli-menu--agents">
          <p className="acli-menu__titre">Nouvel agent</p>
          <div className="acli-menu__choix" role="group" aria-label="Où lancer l'agent">
            <button type="button" aria-pressed={ou === "dossier"} data-ou="dossier" onClick={() => setOu("dossier")} title="Dans le dossier ouvert">
              Dossier courant
            </button>
            <button type="button" aria-pressed={ou === "arbre"} data-ou="arbre" onClick={() => setOu("arbre")} title="Dans un nouvel arbre de travail git (une branche neuve)">
              Nouvel arbre
            </button>
          </div>
          {agents === null ? <p className="acli-menu__note">Recherche des agents installés…</p> : null}
          {installes.map((a) => (
            <div key={a.id} className="acli-menu__ligne" data-agent={a.id}>
              <button
                type="button"
                role="menuitem"
                className="acli-menu__item"
                data-agent={a.id}
                disabled={occupe !== null}
                onClick={() => lancer(a)}
                title={a.chemin ?? a.commande}
              >
                <Icon icon={occupe === a.id ? "solar:refresh-linear" : "solar:play-linear"} width={13} height={13} />
                <span className="acli-menu__libelle">{a.nom}</span>
                {a.reglage.autonomie ? <span className="acli-menu__detail" title="Autonomie complète : l'agent agit sans demander">autonome</span> : null}
              </button>
              {a.reprise ? (
                <button
                  type="button"
                  role="menuitem"
                  className="acli-menu__item acli-menu__reprendre"
                  data-action="reprendre"
                  disabled={occupe !== null}
                  onClick={() => lancer(a, true)}
                  title={`Reprendre une session de ${a.nom} dans le dossier courant`}
                  aria-label={`Reprendre une session de ${a.nom}`}
                >
                  <Icon icon="solar:history-linear" width={13} height={13} />
                </button>
              ) : null}
            </div>
          ))}
          {agents !== null && installes.length === 0 ? <p className="acli-menu__note">Aucun agent trouvé sur ce poste.</p> : null}
          {erreur ? <p className="acli-menu__erreur" role="alert">{erreur}</p> : null}
          <div className="acli-menu__separateur" />
          <button
            type="button"
            role="menuitem"
            className="acli-menu__item"
            data-action="reglages-agents"
            onClick={() => {
              setOuvert(false);
              ouvrirReglages("agentsCli");
            }}
          >
            <Icon icon="solar:settings-linear" width={13} height={13} />
            <span className="acli-menu__libelle">Réglages des agents…</span>
          </button>
        </MenuFlottant>
      ) : null}
    </>
  );
}

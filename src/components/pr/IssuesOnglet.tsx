// Onglet Issues du panneau Git : issues ouvertes du dépôt (GitHub, Forgejo / Gitea).
// « Travailler dessus » : branche + worktree (commandes Git existantes), puis le worktree
// s'ouvre sur une conversation créée pour l'issue, son texte prêt dans la saisie.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import { brancheIssue, consigneIssue } from "./consignes";
import { dateCourte, forgeApi, type Issue } from "./forgeApi";
import { EnteteForge, useForge, type AvisPr } from "./PrOnglet";
import { ouvrirDossierAvecTexte } from "./versAgent";

type Props = {
  workspacePath: string;
  actif: boolean;
  branches: string[];
  branchePrincipale: string | null;
  notifier: (avis: AvisPr) => void;
  ouvrirUrl: (url: string) => void;
};

function erreurTexte(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function IssuesOnglet({ workspacePath, actif, branches, branchePrincipale, notifier, ouvrirUrl }: Props) {
  const { etat, erreur, relire } = useForge(workspacePath, actif);
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<number | null>(null);
  const [choisie, setChoisie] = useState<Issue | null>(null);
  const [branche, setBranche] = useState("");
  const [base, setBase] = useState("");
  const [occupe, setOccupe] = useState<string | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const seq = useRef(0);
  const disponible = Boolean(etat?.depot && !etat.message);

  const charger = useCallback(async () => {
    const n = ++seq.current;
    setOccupe("liste");
    try {
      const liste = await forgeApi.issues(workspacePath);
      if (n === seq.current) {
        setIssues(liste);
        setErreurListe(null);
      }
    } catch (err) {
      if (n === seq.current) setErreurListe(erreurTexte(err));
    } finally {
      if (n === seq.current) setOccupe(null);
    }
  }, [workspacePath]);

  useEffect(() => {
    setIssues(null);
    setChoisie(null);
  }, [workspacePath]);

  useEffect(() => {
    if (actif && disponible) void charger();
  }, [actif, disponible, charger]);

  const preparer = (issue: Issue) => {
    setChoisie(issue);
    setBranche(brancheIssue(issue.numero, issue.titre));
    setBase(branchePrincipale ?? branches[0] ?? "");
    setEchec(null);
  };

  const travailler = async () => {
    if (!choisie || !branche.trim()) return;
    setOccupe("travailler");
    setEchec(null);
    try {
      const cree = await api.gitCreateWorktree(workspacePath, branche.trim(), base || null, false);
      const ouverture = await api.createConversation(cree.worktreePath);
      const id = ouverture.activeConversation.id;
      await api
        .renameConversation(cree.worktreePath, id, `#${choisie.numero} ${choisie.titre}`)
        .catch(() => undefined);
      notifier({ kind: "success", cle: "issue-worktree", text: `${cree.message} Conversation ouverte avec l'issue #${choisie.numero}.` });
      ouvrirDossierAvecTexte(cree.worktreePath, id, consigneIssue(choisie, cree.branch));
      setChoisie(null);
    } catch (err) {
      setEchec(erreurTexte(err));
    } finally {
      setOccupe(null);
    }
  };

  return (
    <div className="git-pr" data-vue="issues">
      <EnteteForge etat={etat} erreur={erreur} onJeton={relire} ouvrirUrl={ouvrirUrl} />
      {disponible && (
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Issues ouvertes</span>
              {issues && issues.length > 0 && <span className="git-panel__count">{issues.length}</span>}
            </span>
            <span className="git-panel__section-actions">
              <button
                type="button"
                className="git-panel__head-btn"
                onClick={() => void charger()}
                disabled={occupe !== null}
                title="Actualiser"
                aria-label="Actualiser les issues"
              >
                {occupe === "liste" ? (
                  <span className="git-panel__spinner git-panel__spinner--inline" />
                ) : (
                  <Icon icon="solar:refresh-linear" width={13} height={13} />
                )}
              </button>
            </span>
          </div>
          {erreurListe ? (
            <div className="git-panel__empty git-pr__erreur">{erreurListe}</div>
          ) : !issues ? (
            <div className="git-panel__empty">Lecture des issues…</div>
          ) : issues.length === 0 ? (
            <div className="git-panel__empty">Aucune issue ouverte.</div>
          ) : (
            <div className="git-panel__rows">
              {issues.map((issue) => (
                <div key={issue.numero} className="git-pr__issue" data-numero={issue.numero} data-ouverte={ouverte === issue.numero ? "true" : "false"}>
                  <div className="git-panel__row git-pr__ligne git-pr__ligne--issue">
                    <button
                      type="button"
                      className="git-pr__issue-titre"
                      onClick={() => setOuverte((n) => (n === issue.numero ? null : issue.numero))}
                      aria-expanded={ouverte === issue.numero}
                      title={issue.titre}
                    >
                      <span className="git-pr__numero">#{issue.numero}</span>
                      <span className="git-pr__ligne-corps">
                        <span className="git-pr__ligne-titre">{issue.titre}</span>
                        <span className="git-pr__ligne-sous">
                          {[issue.etiquettes.join(", "), issue.auteur, dateCourte(issue.maj)].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </button>
                    <span className="git-pr__actions">
                      <button
                        type="button"
                        className="git-pr__bouton git-pr__bouton--petit"
                        data-action="travailler"
                        onClick={() => preparer(issue)}
                        disabled={occupe !== null}
                        title="Branche et worktree pour cette issue, puis une conversation avec son texte"
                      >
                        <Icon icon="solar:play-linear" width={12} height={12} />
                        <span>Travailler dessus</span>
                      </button>
                      <button
                        type="button"
                        className="git-panel__head-btn"
                        onClick={() => ouvrirUrl(issue.url)}
                        title={`Ouvrir ${issue.url}`}
                        aria-label={`Ouvrir l'issue #${issue.numero} dans le navigateur`}
                      >
                        <Icon icon="solar:arrow-right-up-linear" width={12} height={12} />
                      </button>
                    </span>
                  </div>
                  {ouverte === issue.numero && (
                    <div className="git-pr__description">{issue.corps.trim() || "(sans description)"}</div>
                  )}
                  {choisie?.numero === issue.numero && (
                    <div className="git-pr__formulaire" data-formulaire="travailler">
                      <label className="git-panel__dialog-field">
                        <span className="git-panel__dialog-label">Nouvelle branche</span>
                        <input
                          type="text"
                          className="git-panel__dialog-input"
                          data-champ="branche"
                          value={branche}
                          onChange={(e) => setBranche(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && branche.trim()) void travailler();
                            if (e.key === "Escape") setChoisie(null);
                          }}
                          autoFocus
                        />
                      </label>
                      <label className="git-panel__dialog-field">
                        <span className="git-panel__dialog-label">Depuis</span>
                        <select className="git-panel__dialog-select" value={base} onChange={(e) => setBase(e.target.value)} data-champ="base">
                          {branches.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      </label>
                      {echec && <div className="git-panel__dialog-error" role="alert">{echec}</div>}
                      <div className="git-pr__commit-barre">
                        <button type="button" className="git-pr__bouton" onClick={() => setChoisie(null)} disabled={occupe === "travailler"}>
                          Annuler
                        </button>
                        <button
                          type="button"
                          className="git-panel__action"
                          data-action="creer-worktree"
                          onClick={() => void travailler()}
                          disabled={occupe !== null || !branche.trim()}
                        >
                          {occupe === "travailler" ? <span className="git-panel__spinner git-panel__spinner--inline" /> : null}
                          <span>Créer le worktree et ouvrir</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

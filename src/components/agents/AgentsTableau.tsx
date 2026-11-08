// Vue « Tableau » de l'onglet Agents (colonnes par état ; pur : tableauAgents.ts).
import { useMemo, useState } from "react";
import { STATUS_LABEL, type SessionStatus } from "./agentsApi";
import { COLONNES_TABLEAU, depuisQuand, nomDossier, repartir, type EtatTableau } from "./tableauAgents";

export type CarteSession = {
  id: string;
  conn: string;
  name: string;
  parentId?: string;
  workspaceId: string;
  status: SessionStatus;
  updatedAtMs: number;
  scratch?: boolean;
};

type Props<T extends CarteSession> = {
  sessions: T[];
  etats: Record<string, EtatTableau | undefined>;
  /** Afficher le dossier de chaque carte (filtre « tous les dossiers »). */
  tousDossiers: boolean;
  /** Tâche de chaque sous-agent (1re ligne de son premier message), par clé conn:id. */
  taches: Record<string, string>;
  onOuvrir: (session: T) => void;
};

/** Texte de la carte sans le rappel de la colonne (« Fini : », « Échec : »…). */
function texteCarte(etat?: EtatTableau): string {
  return String(etat?.texte ?? "")
    .replace(/^(Attend votre réponse|Échec|Fini)\s*[:.]\s*/u, "")
    .trim();
}

export function AgentsTableau<T extends CarteSession>({ sessions, etats, tousDossiers, taches, onOuvrir }: Props<T>) {
  const [reposOuvert, setReposOuvert] = useState(false);
  const statuts = useMemo(() => new Map(sessions.map((s) => [s.id, s.status as string] as const)), [sessions]);
  const colonnes = useMemo(() => repartir(sessions, statuts, etats), [sessions, statuts, etats]);
  const noms = useMemo(() => new Map(sessions.map((s) => [s.id, s.name] as const)), [sessions]);
  const maintenant = Date.now();
  return (
    <div className="axe-tableau">
      {COLONNES_TABLEAU.map(({ id, titre }) => {
        const liste = colonnes[id];
        const replie = id === "repos" && !reposOuvert;
        return (
          <section key={id} className="axe-tableau__colonne" data-colonne={id} aria-label={`${titre} : ${liste.length}`}>
            <h3 className="axe-tableau__titre">
              <span className="axe-tableau__pastille" data-colonne={id} aria-hidden />
              <span className="axe-tableau__libelle">{titre}</span>
              <span className="axe-tableau__nombre">{liste.length}</span>
              {id === "repos" && liste.length ? (
                <button type="button" className="axe-tableau__plier" aria-expanded={!replie} onClick={() => setReposOuvert((v) => !v)}>
                  {replie ? "Afficher" : "Masquer"}
                </button>
              ) : null}
            </h3>
            {replie || !liste.length ? null : (
              <ul className="axe-tableau__cartes">
                {liste.map((s) => {
                  const etat = etats[s.id];
                  const texte = id === "travaille" || id === "repos" ? (s.parentId ? taches[`${s.conn}:${s.id}`] ?? "" : "") : texteCarte(etat);
                  const quand = depuisQuand(Math.max(s.updatedAtMs || 0, etat?.depuis || 0), maintenant);
                  const parent = s.parentId ? noms.get(s.parentId) : undefined;
                  const details = [
                    s.parentId ? `sous-agent${parent ? ` de ${parent}` : ""}` : s.scratch ? "sans dossier" : "",
                    tousDossiers && !s.scratch ? nomDossier(s.workspaceId) : "",
                    quand,
                  ].filter(Boolean);
                  return (
                    <li key={`${s.conn}:${s.id}`}>
                      <button
                        type="button"
                        className="axe-tableau__carte"
                        data-colonne={id}
                        data-session={s.id}
                        data-sous-agent={s.parentId ? "true" : undefined}
                        title={`${s.name || s.id} — ${STATUS_LABEL[s.status] ?? s.status}${texte ? `\n${texte}` : ""}`}
                        onClick={() => onOuvrir(s)}
                      >
                        <span className="axe-tableau__haut">
                          <span className="axe-agents__dot" data-status={s.status} aria-hidden />
                          <span className="axe-tableau__nom">{s.name || s.id.slice(0, 8)}</span>
                        </span>
                        {texte ? <span className="axe-tableau__texte">{texte}</span> : null}
                        {details.length ? <span className="axe-tableau__details">{details.join(" · ")}</span> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

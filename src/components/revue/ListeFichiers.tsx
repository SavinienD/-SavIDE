// Revue des changements : fichiers modifiés, groupés (en conflit, non indexés, indexés, depuis la base).
import { useState } from "react";
import { Icon } from "@iconify/react";
import type { ActionRevue, FichierRevue, GroupeRevue } from "./revueApi";

const ORDRE: GroupeRevue[] = ["conflit", "non-indexe", "indexe", "base"];

export function titreGroupe(groupe: GroupeRevue, base: string): string {
  switch (groupe) {
    case "conflit":
      return "En conflit";
    case "non-indexe":
      return "Non indexés";
    case "indexe":
      return "Indexés";
    default:
      return `Depuis ${base}`;
  }
}

export function libelleStatut(statut: string): string {
  switch (statut) {
    case "?":
      return "Nouveau fichier, non suivi";
    case "A":
      return "Ajouté";
    case "D":
      return "Supprimé";
    case "U":
      return "En conflit";
    case "T":
      return "Type changé";
    default:
      return "Modifié";
  }
}

/** « src/app.ts » -> ["app.ts", "src"]. */
export function nomEtDossier(chemin: string): [string, string] {
  const i = chemin.lastIndexOf("/");
  return i < 0 ? [chemin, ""] : [chemin.slice(i + 1), chemin.slice(0, i)];
}

type Props = {
  fichiers: FichierRevue[];
  base: string;
  choix: { chemin: string; groupe: GroupeRevue } | null;
  notesParFichier: ReadonlyMap<string, number>;
  occupe: boolean;
  onChoisir: (f: FichierRevue) => void;
  onAction: (f: FichierRevue, action: ActionRevue) => void;
};

export function ListeFichiers({ fichiers, base, choix, notesParFichier, occupe, onChoisir, onAction }: Props) {
  // « Annuler » efface du travail : un premier clic arme, le second confirme.
  const [arme, setArme] = useState<string | null>(null);
  if (!fichiers.length) {
    return <div className="revue-fichiers__vide">Aucun changement</div>;
  }
  return (
    <div className="revue-fichiers" role="list">
      {ORDRE.map((groupe) => {
        const liste = fichiers.filter((f) => f.groupe === groupe);
        if (!liste.length) return null;
        return (
          <section key={groupe} className="revue-fichiers__groupe" data-groupe={groupe}>
            <h3 className="revue-fichiers__titre">
              <span>{titreGroupe(groupe, base)}</span>
              <span className="revue-fichiers__nombre">{liste.length}</span>
            </h3>
            {liste.map((f) => {
              const [nom, dossier] = nomEtDossier(f.chemin);
              const cle = `${f.groupe}:${f.chemin}`;
              const actif = choix?.chemin === f.chemin && choix.groupe === f.groupe;
              const notes = notesParFichier.get(f.chemin) ?? 0;
              return (
                <div key={cle} className="revue-fichier" role="listitem" data-actif={actif ? "true" : "false"} data-fichier={f.chemin}>
                  <button
                    type="button"
                    className="revue-fichier__principal"
                    onClick={() => onChoisir(f)}
                    title={`${f.chemin} · ${libelleStatut(f.statut)}`}
                    aria-current={actif ? "true" : undefined}
                  >
                    <span className="revue-fichier__statut" data-statut={f.statut} aria-hidden="true">
                      {f.statut === "?" ? "N" : f.statut}
                    </span>
                    <span className="revue-fichier__nom">{nom}</span>
                    {dossier ? <span className="revue-fichier__dossier">{dossier}</span> : null}
                    {notes > 0 ? (
                      <span className="revue-fichier__notes" title={`${notes} note${notes > 1 ? "s" : ""}`}>
                        <Icon icon="solar:pen-linear" width={11} height={11} />
                        {notes}
                      </span>
                    ) : null}
                    {f.binaire ? (
                      <span className="revue-fichier__compte">binaire</span>
                    ) : (
                      <span className="revue-fichier__compte">
                        {f.ajouts ? <span className="revue-plus">+{f.ajouts}</span> : null}
                        {f.suppressions ? <span className="revue-moins">−{f.suppressions}</span> : null}
                      </span>
                    )}
                  </button>
                  {f.groupe === "non-indexe" ? (
                    <span className="revue-fichier__actions">
                      <button type="button" className="revue-icone" disabled={occupe} onClick={() => onAction(f, "indexer")} title="Indexer le fichier" aria-label={`Indexer ${f.chemin}`}>
                        <Icon icon="solar:add-square-linear" width={14} height={14} />
                      </button>
                      {f.statut !== "?" ? (
                        <button
                          type="button"
                          className="revue-icone"
                          data-arme={arme === cle ? "true" : "false"}
                          disabled={occupe}
                          onBlur={() => setArme((a) => (a === cle ? null : a))}
                          onClick={() => {
                            if (arme !== cle) {
                              setArme(cle);
                              return;
                            }
                            setArme(null);
                            onAction(f, "annuler");
                          }}
                          title={arme === cle ? "Cliquer encore pour annuler les modifications" : "Annuler les modifications du fichier"}
                          aria-label={`Annuler les modifications de ${f.chemin}`}
                        >
                          <Icon icon="solar:undo-left-linear" width={14} height={14} />
                        </button>
                      ) : null}
                    </span>
                  ) : f.groupe === "indexe" ? (
                    <span className="revue-fichier__actions">
                      <button type="button" className="revue-icone" disabled={occupe} onClick={() => onAction(f, "desindexer")} title="Désindexer le fichier" aria-label={`Désindexer ${f.chemin}`}>
                        <Icon icon="solar:minus-square-linear" width={14} height={14} />
                      </button>
                    </span>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}

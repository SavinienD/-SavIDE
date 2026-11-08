// Réglages > Harnais : fichiers de consignes du dossier (AGENTS.md,
// CLAUDE.md, .claude/CLAUDE.md), dans l'ordre où l'agent les lit, et ce qui en part.
import { useEffect, useState } from "react";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { libelleSource, resumeConsignes, type EtatDesConsignes } from "../../lib/consignes";
import { interopApi } from "../../lib/interopApi";
import "./interop.css";

export function ConsignesDossier({ workspacePath }: { workspacePath: string }) {
  const [etat, setEtat] = useState<EtatDesConsignes | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const cloud = !!cloudConnectionFromPath(workspacePath);

  useEffect(() => {
    if (cloud || !workspacePath) return;
    let vivant = true;
    interopApi
      .consignes(workspacePath)
      .then((e) => {
        if (!vivant) return;
        setEtat(e);
        setErreur(null);
      })
      .catch((e) => {
        if (vivant) setErreur(String(e));
      });
    return () => {
      vivant = false;
    };
  }, [workspacePath, cloud]);

  if (cloud || !workspacePath) return null;
  return (
    <details className="axe-interop__consignes" data-testid="consignes-dossier">
      <summary title="Fichiers de consignes lus par l'agent au début de chaque conversation">
        {resumeConsignes(etat)}
      </summary>
      {erreur ? <p className="axe-harness__error">{erreur}</p> : null}
      {etat ? (
        <>
          <ul className="axe-interop__consignes-liste">
            {etat.sources.map((s) => (
              <li key={s.fichier} data-etat={s.etat} title={s.chemin}>
                <code>{s.fichier}</code>
                <span>{libelleSource(s)}</span>
              </li>
            ))}
          </ul>
          <p className="axe-harness__muted">
            Lus dans cet ordre, {etat.plafond.toLocaleString("fr-FR")} caractères au plus en tout. Un fichier qui
            répète le précédent n'est pas envoyé deux fois.
          </p>
        </>
      ) : null}
    </details>
  );
}

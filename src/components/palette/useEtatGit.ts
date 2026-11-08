// Lot palette (P4) — état git du dossier pour l'explorateur : relu quand l'arbre est
// rafraîchi (fichiers changés, retour de la fenêtre) ; au plus une lecture toutes les 3 s
// pendant qu'un agent travaille (l'arbre est alors rafraîchi chaque seconde).
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { carteGit, type CarteGit, type FichierGit } from "./etatGit";

const ATTENTE_MS = 300;
const ECART_MIN_MS = 3000;

export function useEtatGit(dossier: string, ...jetons: unknown[]): CarteGit | null {
  const [carte, setCarte] = useState<CarteGit | null>(null);
  const derniere = useRef(0);
  useEffect(() => {
    if (cloudConnectionFromPath(dossier)) {
      setCarte(null);
      return;
    }
    let vivant = true;
    const attente = Math.max(ATTENTE_MS, ECART_MIN_MS - (Date.now() - derniere.current));
    const minuterie = window.setTimeout(() => {
      derniere.current = Date.now();
      invoke<{ depot: boolean; fichiers: FichierGit[] }>("explorateur_git", { input: { workspacePath: dossier } })
        .then((r) => vivant && setCarte(r?.depot ? carteGit(r.fichiers ?? []) : null))
        .catch(() => vivant && setCarte(null));
    }, attente);
    return () => {
      vivant = false;
      window.clearTimeout(minuterie);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dossier, ...jetons]);
  return carte;
}

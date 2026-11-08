// Marques de changements dans la marge de Monaco (ajouté / modifié / supprimé)
// par rapport au dernier commit. La version de HEAD est relue à l'ouverture, après chaque
// enregistrement (date du fichier) et au retour dans la fenêtre (commit fait ailleurs) ;
// le texte de l'éditeur est comparé en direct (200 ms après la frappe).

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as monacoNs from "monaco-editor";
import type * as Monaco from "monaco-editor";
import type { EditorTab } from "../../types";
import { marquesDiff, type Marque } from "./margeGit";
import "./editeur.css";

export type FichierHead = {
  etat: "suivi" | "nouveau" | "hors-depot" | "trop-gros" | "sans-git";
  modifie: boolean;
  base64: string | null;
  taille: number;
};

const COULEURS: Record<Marque["genre"], string> = { ajout: "#22c55e", modif: "#6aa1ff", suppr: "#f5737f" };
const cache = new Map<string, { t: number; p: Promise<FichierHead | null> }>();

/** Version HEAD d'un fichier du poste (requêtes rapprochées de plusieurs colonnes regroupées). */
export function lireFichierHead(chemin: string, fraiche = false): Promise<FichierHead | null> {
  const deja = cache.get(chemin);
  if (deja && !fraiche && Date.now() - deja.t < 2000) return deja.p;
  const p = invoke<FichierHead>("editeur_fichier_head", { input: { chemin } }).catch(() => null);
  cache.set(chemin, { t: Date.now(), p });
  if (cache.size > 64) cache.delete(cache.keys().next().value as string);
  return p;
}

export function texteDeBase64(base64: string): string {
  const binaire = atob(base64);
  const octets = new Uint8Array(binaire.length);
  for (let i = 0; i < binaire.length; i++) octets[i] = binaire.charCodeAt(i);
  return new TextDecoder("utf-8").decode(octets);
}

function decoration(m: Marque): Monaco.editor.IModelDeltaDecoration {
  return {
    range: new monacoNs.Range(m.debut, 1, m.fin, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName: `marge-git marge-git--${m.genre}${m.haut ? " marge-git--haut" : ""}`,
      overviewRuler: { color: COULEURS[m.genre], position: monacoNs.editor.OverviewRulerLane.Left },
      minimap: { color: COULEURS[m.genre], position: monacoNs.editor.MinimapPosition.Gutter },
    },
  };
}

/**
 * @param editeur instance Monaco de l'onglet affiché (null : rien)
 * @param onglet onglet de fichier affiché dans l'éditeur (texte), sinon undefined
 * @param version change à chaque nouvelle instance de Monaco
 * @param local false pour un espace distant (pas de Git du poste)
 */
export function useMargeGit(
  editeur: Monaco.editor.IStandaloneCodeEditor | null,
  onglet: EditorTab | undefined,
  version: number,
  local: boolean,
): void {
  const chemin = local && onglet && !onglet.external ? onglet.doc.absolutePath : null;
  const date = onglet?.doc.lastModifiedMs ?? null;
  const [head, setHead] = useState<{ chemin: string; texte: string | null } | null>(null);
  useEffect(() => {
    if (!chemin) {
      setHead(null);
      return;
    }
    let fini = false;
    const lire = (fraiche: boolean) =>
      void lireFichierHead(chemin, fraiche).then((r) => {
        if (fini) return;
        const texte = r?.etat === "suivi" && r.base64 !== null ? texteDeBase64(r.base64) : null;
        setHead((avant) => (avant?.chemin === chemin && avant.texte === texte ? avant : { chemin, texte }));
      });
    lire(false);
    const auRetour = () => lire(true);
    window.addEventListener("focus", auRetour);
    return () => {
      fini = true;
      window.removeEventListener("focus", auRetour);
    };
  }, [chemin, date]);

  const collectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  useEffect(() => {
    if (!editeur) return;
    const collection = editeur.createDecorationsCollection();
    collectionRef.current = collection;
    return () => {
      collection.clear();
      if (collectionRef.current === collection) collectionRef.current = null;
    };
  }, [editeur, version]);

  const texte = onglet?.buffer ?? "";
  useEffect(() => {
    const collection = collectionRef.current;
    if (!collection || !editeur?.getModel()) return;
    if (!head || head.chemin !== chemin || head.texte === null) {
      collection.clear();
      return;
    }
    const avant = head.texte;
    const minuterie = window.setTimeout(() => collection.set(marquesDiff(avant, texte).map(decoration)), 200);
    return () => window.clearTimeout(minuterie);
  }, [head, chemin, texte, editeur, version]);
}

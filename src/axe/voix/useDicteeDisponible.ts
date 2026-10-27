// axe:0.1.71 — disponibilité de la dictée (voix_etat), mise en cache une minute.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import { dicteeDisponible, type EtatVoix, type OptionsDisponibilite } from "./disponibilite";

const DUREE_CACHE_MS = 60_000;
const cache = new Map<string, { quand: number; promesse: Promise<EtatVoix | null> }>();

export function lireEtatVoix(workspacePath?: string, forcer = false): Promise<EtatVoix | null> {
  const cle = workspacePath ?? "";
  const deja = cache.get(cle);
  if (!forcer && deja && Date.now() - deja.quand < DUREE_CACHE_MS) return deja.promesse;
  const promesse = invoke<EtatVoix>("voix_etat", { input: { workspacePath: workspacePath ?? null } }).catch(() => null);
  cache.set(cle, { quand: Date.now(), promesse });
  return promesse;
}

/** null tant que l'état n'est pas connu, puis vrai/faux. */
export function useDicteeDisponible(workspacePath?: string, options: OptionsDisponibilite = {}): boolean | null {
  const [dispo, setDispo] = useState<boolean | null>(null);
  const local = options.localSeulement === true;
  useEffect(() => {
    let fini = false;
    void lireEtatVoix(workspacePath).then((etat) => {
      if (!fini) setDispo(dicteeDisponible(etat, { localSeulement: local }));
    });
    return () => {
      fini = true;
    };
  }, [workspacePath, local]);
  return dispo;
}

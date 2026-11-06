// catalogue des fournisseurs intégrés : MODELS complété par les modèles que
// l'API annonce (commande `catalogue_modeles` : relue au démarrage, puis le moteur ne rappelle
// l'API qu'une fois par jour ; demandé ici toutes les heures et quand un fournisseur change).
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MODELS, type ModelEntry } from "./models";
import { completerCatalogue, type CatalogueDecouvert } from "./catalogueModeles";
import { PROVIDERS_CHANGED_EVENT } from "../axe/providers";

const HEURE_MS = 3_600_000;
let actuel: readonly ModelEntry[] = MODELS;
const abonnes = new Set<(c: readonly ModelEntry[]) => void>();
let enCours: Promise<void> | null = null;
let minuterie: number | null = null;

function relire(): Promise<void> {
  enCours ??= invoke<CatalogueDecouvert>("catalogue_modeles", { forcer: false })
    .then((c) => {
      const suivant = completerCatalogue(MODELS, c);
      if (JSON.stringify(suivant) === JSON.stringify(actuel)) return;
      actuel = suivant;
      abonnes.forEach((f) => f(actuel));
    })
    .catch(() => {
      /* moteur ancien ou hors ligne : la liste en dur reste */
    })
    .finally(() => {
      enCours = null;
    });
  return enCours;
}

/** Liste des modèles des fournisseurs intégrés (MODELS + découverts). */
export function useCatalogueModeles(): readonly ModelEntry[] {
  const [catalogue, setCatalogue] = useState(actuel);
  useEffect(() => {
    abonnes.add(setCatalogue);
    setCatalogue(actuel);
    if (minuterie === null) {
      void relire();
      minuterie = window.setInterval(() => void relire(), HEURE_MS);
      window.addEventListener(PROVIDERS_CHANGED_EVENT, () => void relire());
    }
    return () => {
      abonnes.delete(setCatalogue);
    };
  }, []);
  return catalogue;
}

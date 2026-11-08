// Lot palette — Ctrl+K sur l'accueil (aucun dossier ouvert) : dossiers récents et
// conversations de tous les dossiers, recherche dans leur texte. Ctrl+P y est avalé (pas
// d'impression de la page). Montée dans App.tsx (une ligne d'accroche).
import { useEffect, useMemo, useState } from "react";
import { fournirActions } from "../../axe/raccourcis";
import { PaletteAller, type ContexteAller } from "./PaletteAller";
import { actionsAide } from "./actionsAide";

type Props = {
  ouvrirDossier: (chemin: string, conversationId?: string) => unknown;
  ouvrirLibre: (conversationId?: string) => unknown;
};

export function PaletteAccueil({ ouvrirDossier, ouvrirLibre }: Props) {
  const [ouverte, setOuverte] = useState(false);
  useEffect(() => fournirActions({ allerA: () => setOuverte(true), ouvrirFichier: () => undefined }), []);
  const contexte = useMemo<ContexteAller>(() => ({ ouvrirDossier, ouvrirLibre, actions: actionsAide() }), [ouvrirDossier, ouvrirLibre]);
  return ouverte ? <PaletteAller contexte={contexte} onFermer={() => setOuverte(false)} /> : null;
}

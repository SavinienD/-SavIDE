// Lot 186 — l'onglet « Navigateur » dans l'IDE : état ouvert / affiché, bouton de la barre
// de titre, liens du chat et du terminal, demande de l'agent (navigateur.ouvrir). Le
// Workspace n'a que quelques lignes d'accroche : ce hook rend l'onglet spécial pour
// l'éditeur (EditorPane.ongletsSpeciaux) et le bouton de la barre.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { infoBulle } from "../../axe/raccourcis";
import type { OngletSpecial } from "../EditorPane";
import { enregistrerOuvreur } from "./liens";
import { ecouterNavigateur, navigateurApi } from "./navigateurApi";
import { OngletNavigateur } from "./OngletNavigateur";
import "./navigateur.css";

type Options = {
  workspacePath: string;
  conversationId: string;
  settingsActive: boolean;
  remoteActive: boolean;
  activeTabIndex: number;
  /** Retire l'état « affiché » des Réglages et de « À distance » (l'onglet Navigateur passe devant). */
  quitterAutres: () => void;
};

export type OngletNavigateurIde = {
  onglets: OngletSpecial[];
  bouton: ReactNode;
  ouvrir: (url?: string) => void;
  /** Un autre onglet de l'éditeur passe devant. */
  quitter: () => void;
  /** Ctrl+W : ferme l'onglet Navigateur s'il est affiché (vrai), sinon rien (faux). */
  fermerSiActif: () => boolean;
};

export function useOngletNavigateur(o: Options): OngletNavigateurIde {
  const [ouvert, setOuvert] = useState(false);
  const [actif, setActif] = useState(false);
  const [demande, setDemande] = useState<{ url: string; n: number } | null>(null);
  const quitterAutresRef = useRef(o.quitterAutres);
  quitterAutresRef.current = o.quitterAutres;
  const actifRef = useRef(actif);
  actifRef.current = actif;

  // Un fichier, les Réglages ou « À distance » passent devant : l'onglet Navigateur se retire.
  const avant = useRef({ s: o.settingsActive, r: o.remoteActive, t: o.activeTabIndex });
  useEffect(() => {
    const p = avant.current;
    if ((o.settingsActive && !p.s) || (o.remoteActive && !p.r) || o.activeTabIndex !== p.t) setActif(false);
    avant.current = { s: o.settingsActive, r: o.remoteActive, t: o.activeTabIndex };
  }, [o.settingsActive, o.remoteActive, o.activeTabIndex]);

  const ouvrir = useCallback((url?: string) => {
    setOuvert(true);
    setActif(true);
    quitterAutresRef.current();
    if (url) setDemande({ url, n: Date.now() });
  }, []);

  const fermer = useCallback(() => {
    setOuvert(false);
    setActif(false);
    void navigateurApi.fermer().catch(() => undefined);
  }, []);

  const quitter = useCallback(() => setActif(false), []);
  const fermerSiActif = useCallback(() => {
    if (!actifRef.current) return false;
    fermer();
    return true;
  }, [fermer]);

  // Ce dossier est ouvert dans cette fenêtre : l'agent du dossier pilotera ce navigateur.
  useEffect(() => {
    void navigateurApi.enregistrer(o.workspacePath).catch(() => undefined);
  }, [o.workspacePath]);

  // L'agent a ouvert une page (navigateur.ouvrir) : l'onglet s'affiche.
  useEffect(() => ecouterNavigateur({ demande: () => ouvrir() }), [ouvrir]);

  // Liens du chat et du terminal (selon Réglages > Navigateur).
  useEffect(() => enregistrerOuvreur((url) => ouvrir(url)), [ouvrir]);

  const vue = useMemo(
    () => <OngletNavigateur workspacePath={o.workspacePath} actif={actif} conversationId={o.conversationId} demande={demande} />,
    [o.workspacePath, actif, o.conversationId, demande],
  );

  const onglets: OngletSpecial[] = ouvert
    ? [{
        cle: "navigateur",
        titre: "Navigateur",
        icone: "solar:global-linear",
        actif,
        vue,
        onActiver: () => {
          setActif(true);
          quitterAutresRef.current();
        },
        onFermer: fermer,
      }]
    : [];

  const bouton = (
    <button
      className="titlebar__btn"
      data-bouton="navigateur"
      data-on={ouvert && actif ? "true" : "false"}
      onClick={() => ouvrir()}
      title={infoBulle("Navigateur intégré", "navigateur")}
      aria-label="Navigateur intégré"
    >
      <Icon icon="solar:global-linear" width={12} height={12} />
      <span className="titlebar__btn-label">Navigateur</span>
    </button>
  );

  return { onglets, bouton, ouvrir, quitter, fermerSiActif };
}

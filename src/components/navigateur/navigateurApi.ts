// Lot 186 — navigateur intégré : commandes de l'appli (src-tauri/src/navigateur) et
// événements. La page affichée est une vue native posée par l'appli au-dessus de
// l'onglet : ce module ne fait que la placer, la piloter et écouter son état.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type EtatNavigateur = {
  fenetre: string;
  ouvert: boolean;
  url: string;
  titre: string;
  chargement: boolean;
  pret: boolean;
  design: boolean;
  refus: string | null;
};

export type ElementChoisi = {
  url: string;
  titre: string;
  balise: string;
  selecteur: string;
  html: string;
  texte: string;
  largeur: number;
  hauteur: number;
  x: number;
  y: number;
  styles: Record<string, string>;
  attributs: Record<string, string>;
};

export type PortOuvert = { port: number; adresse: string; pid: number; processus: string; url: string };

/** Rectangle de l'onglet en pixels logiques de la fenêtre (CSS × zoom de l'interface). */
export type Zone = { x: number; y: number; largeur: number; hauteur: number };

export type ActionNavigateur = "precedent" | "suivant" | "recharger" | "arreter" | "devtools";

export const ETAT_VIDE: EtatNavigateur = {
  fenetre: "",
  ouvert: false,
  url: "",
  titre: "",
  chargement: false,
  pret: false,
  design: false,
  refus: null,
};

export const navigateurApi = {
  enregistrer: (espace: string) => invoke<EtatNavigateur>("navigateur_enregistrer", { espace }),
  placer: (espace: string, zone: Zone | null) => invoke<EtatNavigateur>("navigateur_placer", { espace, zone }),
  aller: (adresse: string) => invoke<string>("navigateur_aller", { adresse }),
  action: (action: ActionNavigateur) => invoke<void>("navigateur_action", { action }),
  zoom: (facteur: number) => invoke<number>("navigateur_zoom", { facteur }),
  fermer: () => invoke<EtatNavigateur>("navigateur_fermer"),
  etat: () => invoke<EtatNavigateur>("navigateur_etat"),
  design: (actif: boolean) => invoke<EtatNavigateur>("navigateur_design", { actif }),
  ports: (espace: string) => invoke<PortOuvert[]>("navigateur_ports", { espace }),
};

/** Libellé de la fenêtre courante (les événements de l'appli portent celui de leur fenêtre). */
export async function fenetreCourante(): Promise<string> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

type Rappels = {
  etat?: (etat: EtatNavigateur) => void;
  choix?: (element: ElementChoisi) => void;
  /** L'agent a ouvert le navigateur : l'onglet doit s'afficher. */
  demande?: () => void;
  telechargement?: (t: { fichier: string; fini: boolean; ok: boolean }) => void;
};

/** Écoute les événements du navigateur de CETTE fenêtre ; renvoie la fonction d'arrêt. */
export function ecouterNavigateur(rappels: Rappels): () => void {
  let fini = false;
  const arrets: UnlistenFn[] = [];
  void (async () => {
    const fenetre = await fenetreCourante();
    const pour = (charge: { fenetre?: string } | null | undefined) => !!charge && charge.fenetre === fenetre;
    const abonnements: [string, (charge: any) => void][] = [
      ["navigateur://etat", (c: EtatNavigateur) => pour(c) && rappels.etat?.(c)],
      ["navigateur://choix", (c: { fenetre: string; element: ElementChoisi }) => pour(c) && rappels.choix?.(c.element)],
      ["navigateur://demande", (c: { fenetre: string }) => pour(c) && rappels.demande?.()],
      ["navigateur://telechargement", (c: { fenetre: string; fichier: string; fini: boolean; ok: boolean }) => pour(c) && rappels.telechargement?.(c)],
    ];
    for (const [nom, f] of abonnements) {
      try {
        const arret = await listen(nom, (e) => f(e.payload));
        if (fini) arret();
        else arrets.push(arret);
      } catch {
        /* hors de l'appli (tests) : pas d'événements */
      }
    }
  })();
  return () => {
    fini = true;
    for (const a of arrets.splice(0)) a();
  };
}

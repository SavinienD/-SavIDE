// navigateur intégré simulé pour le banc (la vue native n'existe pas ici) :
// état de la page, serveurs du dossier (ports), Design Mode qui choisit un élément.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { emit } from "@tauri-apps/api/event";
import type { Scene } from "./simulation";

type SceneNavigateur = { url?: string; titre?: string; ports?: boolean; choix?: boolean };

const PORTS = [
  { port: 3000, adresse: "127.0.0.1", pid: 4120, processus: "node", url: "http://localhost:3000/" },
  { port: 5173, adresse: "::1", pid: 4188, processus: "node", url: "http://localhost:5173/" },
  { port: 8000, adresse: "0.0.0.0", pid: 5210, processus: "python3", url: "http://localhost:8000/" },
];

const ELEMENT = {
  url: "http://localhost:5173/",
  titre: "Tableau de bord — démo",
  balise: "button",
  selecteur: "main > section.cartes > button.btn-principal:nth-of-type(2)",
  html: '<button class="btn-principal" type="submit">Enregistrer les modifications</button>',
  texte: "Enregistrer les modifications",
  largeur: 212,
  hauteur: 40,
  x: 548,
  y: 316,
  styles: {
    display: "inline-flex", position: "relative", width: "212px", height: "40px", margin: "0px 8px",
    padding: "10px 18px", color: "rgb(255, 255, 255)", "background-color": "rgb(37, 99, 235)",
    "border-radius": "10px", "font-family": "Inter, system-ui, sans-serif", "font-size": "15px", "font-weight": "600",
  },
  attributs: { class: "btn-principal", type: "submit" },
};

export function simulationNavigateur(scene: Scene): Record<string, (a: any, brut: any) => unknown> {
  const nav = (scene.navigateur ?? {}) as SceneNavigateur;
  const etat = { fenetre: "main", ouvert: false, url: "", titre: "", chargement: false, pret: false, design: false, refus: null as string | null };
  if (nav.url) Object.assign(etat, { ouvert: true, url: nav.url, titre: nav.titre ?? "", pret: true });
  const diffuser = () => void emit("navigateur://etat", { ...etat });
  return {
    navigateur_enregistrer: () => ({ ...etat }),
    navigateur_etat: () => ({ ...etat }),
    navigateur_placer: () => ({ ...etat }),
    navigateur_aller: (a) => {
      Object.assign(etat, { ouvert: true, url: String(a?.adresse ?? ""), pret: true, chargement: false });
      window.setTimeout(diffuser, 30);
      return etat.url;
    },
    navigateur_action: () => null,
    navigateur_zoom: (a) => a?.facteur ?? 1,
    navigateur_fermer: () => {
      etat.ouvert = false;
      return { ...etat };
    },
    navigateur_design: (a) => {
      etat.design = !!a?.actif;
      if (etat.design && nav.choix) {
        window.setTimeout(() => {
          void emit("navigateur://choix", { fenetre: "main", element: ELEMENT });
          etat.design = false;
          diffuser();
        }, 150);
      }
      return { ...etat };
    },
    navigateur_ports: () => (nav.ports === false ? [] : PORTS),
  };
}

// automatisations — écoute les fins d'exécution annoncées par le service et les montre
// (événement `ide-notification`) ; au démarrage, résume celles faites appli fermée.
import { useEffect } from "react";
import { agentsApi } from "../agents/agentsApi";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import { automatisationsApi } from "./automatisationsApi";
import { CLE_VU, emettre, notificationDeFin, resumeAbsence } from "./notifications";

/** Une seule fois par démarrage de l'appli (l'écran est monté sur l'accueil et dans un dossier). */
let resumeFait = false;

function lireVu(): number | null {
  try {
    const v = localStorage.getItem(CLE_VU);
    return v && Number.isFinite(Number(v)) ? Number(v) : null;
  } catch {
    return null;
  }
}

function noterVu(ms: number): void {
  try {
    localStorage.setItem(CLE_VU, String(ms));
  } catch {
    /* stockage indisponible */
  }
}

export function useNotificationsAutomatisations(): void {
  useEffect(() => {
    let fin: (() => void) | undefined;
    let vivant = true;
    void agentsApi
      .onEvent((ev) => {
        if ((ev.event as string) !== "automatisations") return;
        const detail = notificationDeFin(ev.data);
        if (!detail) return;
        emettre(detail);
        noterVu(Date.now());
      })
      .then((f) => (vivant ? (fin = f) : f()))
      .catch(() => undefined);
    if (!resumeFait) {
      resumeFait = true;
      const vu = lireVu();
      void automatisationsApi
        .lister(LOCAL_CONNECTION)
        .then((r) => {
          const detail = vu === null ? null : resumeAbsence(r?.automatisations ?? [], vu);
          if (detail) emettre(detail);
          noterVu(typeof r?.maintenantMs === "number" ? r.maintenantMs : Date.now());
        })
        .catch(() => undefined);
    }
    return () => {
      vivant = false;
      fin?.();
    };
  }, []);
}


// Badge « Mise à jour X disponible » (demande de Savinien, 23/10) : jamais
// d'installation automatique ; le badge s'affiche et attend un clic.
import type { UpdateInfo } from "../types";

export type StatutMaj =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; downloaded: number; total: number | null }
  | { kind: "ready"; info: UpdateInfo }
  | { kind: "error"; message: string };

export function libelleMaj(version: string | null | undefined): string {
  return version ? `Mise à jour ${version} disponible` : "Mise à jour disponible";
}

/// Après une vérification : un téléchargement ou une installation en cours n'est
/// jamais écrasé ; une version disponible donne le badge (« available »), rien d'autre.
/// Une version déjà installée (manifeste relu après redémarrage) ne donne aucun badge.
export function statutApresVerification(courant: StatutMaj, info: UpdateInfo): StatutMaj {
  if (courant.kind === "downloading" || courant.kind === "ready") return courant;
  if (info.available && info.version && info.version !== info.currentVersion) {
    return { kind: "available", info };
  }
  return { kind: "idle" };
}

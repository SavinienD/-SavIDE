// Version de l'appli et date de la dernière mise à jour (Réglages > À propos).
// La version est lue à l'exécution (API Tauri getVersion). La date de mise à jour est
// notée au premier lancement d'une version différente de la précédente ; au tout premier
// lancement suivi (installation neuve ou version antérieure à ce suivi), elle est inconnue.
export const CLE_VERSION_LANCEE = "axe:version-lancee";

export type VersionLancee = { version: string; majLe: string | null };

type Stock = { getItem(cle: string): string | null; setItem(cle: string, valeur: string): void };

function lire(stock: Stock): VersionLancee | null {
  try {
    const brut = stock.getItem(CLE_VERSION_LANCEE);
    if (!brut) return null;
    const v = JSON.parse(brut) as Partial<VersionLancee>;
    if (typeof v?.version !== "string" || !v.version) return null;
    return { version: v.version, majLe: typeof v.majLe === "string" ? v.majLe : null };
  } catch {
    return null;
  }
}

/** Note le lancement de `version` et renvoie l'état à jour (idempotent pour une même version). */
export function noterLancement(stock: Stock, version: string, maintenant: Date = new Date()): VersionLancee {
  const avant = lire(stock);
  if (avant && avant.version === version) return avant;
  const etat: VersionLancee = { version, majLe: avant ? maintenant.toISOString() : null };
  try {
    stock.setItem(CLE_VERSION_LANCEE, JSON.stringify(etat));
  } catch {
    /* stockage indisponible : la date restera inconnue */
  }
  return etat;
}

/** « 23 octobre 2026 », ou null si la date est inconnue ou illisible. */
export function dateMajLisible(majLe: string | null): string | null {
  if (!majLe) return null;
  const d = new Date(majLe);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/** Version de l'appli lue à l'exécution ; null hors de l'appli de bureau (navigateur). */
export async function versionAppli(): Promise<string | null> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    const v = await getVersion();
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

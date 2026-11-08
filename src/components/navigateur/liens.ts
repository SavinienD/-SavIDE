// où s'ouvrent les liens http(s) du chat et du terminal : navigateur intégré
// (onglet Navigateur de l'IDE) ou navigateur du système. Réglage gardé dans le stockage
// local ; Maj (avec le clic) inverse le choix pour un lien.
// Module sans React (testé par node).

export type ModeLiens = "local" | "integre" | "systeme";

export const MODES_LIENS: { id: ModeLiens; libelle: string; detail: string }[] = [
  { id: "local", libelle: "Adresses locales dans l'IDE", detail: "localhost et réseau local dans le navigateur intégré, le reste dans le navigateur du système" },
  { id: "integre", libelle: "Navigateur intégré", detail: "tous les liens dans l'onglet Navigateur de l'IDE" },
  { id: "systeme", libelle: "Navigateur du système", detail: "tous les liens dans le navigateur par défaut de l'ordinateur" },
];

export const CLE_MODE_LIENS = "axecode:navigateur:liens";
export const EVENEMENT_MODE_LIENS = "axecode:navigateur-liens";

export function lireModeLiens(stockage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage): ModeLiens {
  try {
    const v = stockage?.getItem(CLE_MODE_LIENS);
    return v === "integre" || v === "systeme" || v === "local" ? v : "local";
  } catch {
    return "local";
  }
}

export function ecrireModeLiens(mode: ModeLiens): void {
  try {
    localStorage.setItem(CLE_MODE_LIENS, mode);
  } catch {
    /* stockage indisponible : réglage pour cette session seulement */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(EVENEMENT_MODE_LIENS, { detail: mode }));
}

/** Hôte local ou du réseau local (serveur de développement). */
export function estAdresseLocale(url: string): boolean {
  let hote: string;
  try {
    hote = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (hote === "localhost" || hote.endsWith(".localhost") || hote === "::1" || hote === "0.0.0.0" || hote.endsWith(".local")) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hote);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** Décision pure : le lien va-t-il dans le navigateur intégré ? */
export function versNavigateurIntegre(url: string, mode: ModeLiens, inverser = false): boolean {
  if (!/^https?:\/\//i.test(url.trim())) return false;
  const integre = mode === "integre" || (mode === "local" && estAdresseLocale(url));
  return inverser ? !integre : integre;
}

type Ouvreur = (url: string) => void;
const ouvreurs: Ouvreur[] = [];

/** L'IDE (onglet Navigateur) s'inscrit pour recevoir les liens ; renvoie le retrait. */
export function enregistrerOuvreur(f: Ouvreur): () => void {
  ouvreurs.push(f);
  return () => {
    const i = ouvreurs.lastIndexOf(f);
    if (i >= 0) ouvreurs.splice(i, 1);
  };
}

/** Ouvre un lien du chat ou du terminal selon le réglage. Sans IDE affiché (accueil,
 *  conversation sans dossier), le navigateur du système. */
export function ouvrirLien(url: string, ouvrirSysteme: (url: string) => unknown, inverser = false): void {
  const ouvreur = ouvreurs[ouvreurs.length - 1];
  if (ouvreur && versNavigateurIntegre(url, lireModeLiens(), inverser)) {
    ouvreur(url.trim());
    return;
  }
  void ouvrirSysteme(url);
}

/** Pour les tests. */
export function reinitialiserOuvreurs(): void {
  ouvreurs.length = 0;
}

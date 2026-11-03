// plateforme — détection du système et affichage des raccourcis, en un seul endroit.
// Sur macOS la touche de commande de l'appli est Cmd (⌘) et Alt s'appelle Option (⌥) ;
// sous Windows et Linux, Ctrl et Alt. Les registres déclarent « Ctrl », « Alt »,
// « Maj » : `formaterRaccourci` les traduit pour l'affichage, `modPrincipal` pour
// la lecture des événements clavier.

type NavigatorPlateforme = { platform?: string; userAgent?: string; userAgentData?: { platform?: string } };

function nomPlateforme(nav?: NavigatorPlateforme): string {
  const n = nav ?? (typeof navigator !== "undefined" ? (navigator as unknown as NavigatorPlateforme) : undefined);
  if (!n) return "";
  return n.userAgentData?.platform || n.platform || n.userAgent || "";
}

/** Vrai sur macOS (et iPadOS). `nav` : pour les tests. */
export function estMac(nav?: NavigatorPlateforme): boolean {
  return /mac|iphone|ipad/i.test(nomPlateforme(nav));
}

/** Vrai sous Windows. `nav` : pour les tests. */
export function estWindows(nav?: NavigatorPlateforme): boolean {
  return /win/i.test(nomPlateforme(nav));
}

type ToucheModif = { ctrlKey: boolean; metaKey: boolean };

/** Touche de commande de l'appli : Cmd sur macOS, Ctrl ailleurs. */
export function modPrincipal(e: ToucheModif, mac: boolean = estMac()): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

const MODIFS_MAC: Record<string, string> = { ctrl: "⌘", cmd: "⌘", alt: "⌥", option: "⌥", maj: "⇧", shift: "⇧", "contrôle": "⌃", control: "⌃" };
const ORDRE_MAC = ["⌃", "⌥", "⇧", "⌘"];

/**
 * Libellé d'une combinaison pour ce système. Entrée : « Ctrl + Maj + D », « Ctrl+, »…
 * Sur macOS : « ⇧⌘D », « ⌘, », « ⌥⌘B », « ⌘ Page suiv. » ; ailleurs, inchangé.
 * « Contrôle » désigne la vraie touche Control (⌃ sur Mac, Ctrl ailleurs).
 */
export function formaterRaccourci(combinaison: string, mac: boolean = estMac()): string {
  if (!mac) return combinaison.replace(/Contrôle/g, "Ctrl");
  // Découpe sur « + » en gardant la touche « + » finale (« Ctrl + + », « Ctrl++ »).
  const m = /^((?:\s*(?:Ctrl|Cmd|Alt|Option|Maj|Shift|Contrôle|Control)\s*\+)+)\s*(.*)$/i.exec(combinaison);
  if (!m) return combinaison;
  const modifs = m[1].split("+").map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => MODIFS_MAC[s]);
  const tri = ORDRE_MAC.filter((s) => modifs.includes(s)).join("");
  const touche = m[2].trim();
  if (!touche) return tri;
  return touche.length > 1 && !/^[−+]$/.test(touche) ? `${tri} ${touche}` : `${tri}${touche}`;
}

/** Remplace dans un texte les combinaisons entre parenthèses ou citées : « Dicter (Ctrl+Maj+D) ». */
export function formaterTexte(texte: string, mac: boolean = estMac()): string {
  if (!mac) return texte;
  return texte.replace(/(?:(?:Ctrl|Alt|Maj|Contrôle)\s*\+\s*)+(?:[^\s(),]+(?: suiv\.| préc\.)?|,)/g, (c) => formaterRaccourci(c, true));
}

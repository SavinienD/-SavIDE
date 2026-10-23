// axe:parcours-collegue — section des Réglages demandée par un bouton (par ex. « Connect a
// provider » du compositeur). Avant, l'événement partait avant le montage du volet des
// Réglages : personne ne l'écoutait et le volet s'ouvrait sur « About ». La demande est donc
// aussi gardée ici et lue par le volet à son montage. Module pur, testé par
// tests/sectionReglages.test.cjs.
export const EVENEMENT_SECTION_REGLAGES = "axecode:open-settings-section";

let demandee: string | null = null;

/** Ouvre les Réglages sur `section` : volet déjà monté, par l'événement ; sinon, lue au montage. */
export function demanderSectionReglages(
  section: string,
  cible: EventTarget | null = typeof window === "undefined" ? null : window,
): void {
  demandee = section;
  cible?.dispatchEvent(new CustomEvent(EVENEMENT_SECTION_REGLAGES, { detail: { section } }));
}

/** Section demandée que le volet n'a pas encore prise en compte (null : aucune). */
export function sectionReglagesDemandee(): string | null {
  return demandee;
}

/** Le volet a pris la demande en compte. */
export function oublierSectionReglages(): void {
  demandee = null;
}

// axe:fr — titre par défaut d'une conversation neuve, posé par le moteur en anglais
// (« New conversation » : crates/axecode-app/src/store.rs, comparé aussi par src-tauri/src/freechat.rs).
// La donnée garde l'anglais ; l'interface affiche le français.
export const TITRES_PAR_DEFAUT: ReadonlySet<string> = new Set(["New conversation", "Untitled"]);

/** Titre de conversation tel qu'il s'affiche (liste, onglets). */
export function titreAffiche(titre: string | null | undefined, vide = "Sans titre"): string {
  const t = (titre ?? "").trim();
  if (!t) return vide;
  return TITRES_PAR_DEFAUT.has(t) ? "Nouvelle conversation" : t;
}

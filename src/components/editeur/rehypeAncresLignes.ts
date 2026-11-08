// Ancres de lignes dans l'aperçu Markdown : un <span data-ligne="N"> vide en tête
// des titres, paragraphes, éléments de liste, blocs de code (dans <code>, pour que <pre> garde un
// seul enfant) et lignes de tableau (première cellule). Elles servent au défilement synchronisé
// avec l'éditeur (côte à côte) et à retrouver la ligne source d'un endroit de l'aperçu.
// Plugin rehype sans dépendance (à placer après rehype-highlight, qui réécrit le contenu de <code>).

type Noeud = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Noeud[];
  position?: { start?: { line?: number } };
};

const BLOCS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "li"]);

function premierEnfant(n: Noeud, balises: string[]): Noeud | undefined {
  return n.children?.find((e) => e.type === "element" && balises.includes(e.tagName ?? ""));
}

function poser(cible: Noeud, ligne: number): void {
  const ancre: Noeud = {
    type: "element",
    tagName: "span",
    properties: { className: ["md-ligne"], dataLigne: ligne, ariaHidden: "true" },
    children: [],
  };
  cible.children = [ancre, ...(cible.children ?? [])];
}

function parcourir(noeud: Noeud): void {
  for (const enfant of noeud.children ?? []) {
    if (enfant.type !== "element") continue;
    const ligne = enfant.position?.start?.line;
    if (ligne) {
      const balise = enfant.tagName ?? "";
      if (BLOCS.has(balise)) poser(enfant, ligne);
      else if (balise === "pre") {
        const code = premierEnfant(enfant, ["code"]);
        if (code) poser(code, ligne);
      } else if (balise === "tr") {
        const cellule = premierEnfant(enfant, ["th", "td"]);
        if (cellule) poser(cellule, ligne);
      }
    }
    parcourir(enfant);
  }
}

export function rehypeAncresLignes() {
  return (arbre: Noeud) => {
    parcourir(arbre);
  };
}

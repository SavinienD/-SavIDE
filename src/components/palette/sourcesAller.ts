// Lot palette — Ctrl+K « Aller à » : éléments de toutes les sources (onglets, conversations,
// dossiers, sous-agents, terminaux, Réglages, actions), filtrés et groupés. Module pur, testé
// par tests/paletteAller.test.cjs.
import { correspondance, plier, termesDe } from "./flou";
import { isExecutablePathTitle } from "../terminalTabs";
import type { ElementPalette } from "./Palette";

export type GenreSource = "onglet" | "fichier" | "conversation" | "dossier" | "sousAgent" | "terminal" | "reglage" | "action";

export type Source = {
  genre: GenreSource;
  /** Identifiant dans son genre (chemin, id de conversation…). */
  id: string;
  titre: string;
  /** Ligne secondaire, cherchée aussi (dossier d'une conversation, chemin…). */
  detail?: string;
  icone: string;
  indication?: string;
  /** Rang par défaut (récence) : 0 = premier. */
  ordre: number;
  /** Mots cherchés en plus, non affichés (mots-clés d'un réglage…). */
  cle?: string;
  /** Proposé seulement quand on tape (un réglage précis, pas toute la liste). */
  seulementSiCherche?: boolean;
};

type Groupe = { titre: string; vide: number; plein: number };

/** Ordre et taille des groupes : requête vide (vide) ou non (plein). */
export const GROUPES: Record<GenreSource, Groupe> = {
  onglet: { titre: "Onglets ouverts", vide: 12, plein: 6 },
  fichier: { titre: "Onglets ouverts", vide: 12, plein: 6 },
  conversation: { titre: "Conversations", vide: 8, plein: 8 },
  dossier: { titre: "Dossiers récents", vide: 6, plein: 6 },
  sousAgent: { titre: "Sous-agents", vide: 5, plein: 5 },
  terminal: { titre: "Terminaux", vide: 8, plein: 4 },
  reglage: { titre: "Réglages", vide: 12, plein: 6 },
  action: { titre: "Actions", vide: 8, plein: 6 },
};
const ORDRE: GenreSource[] = ["onglet", "fichier", "conversation", "dossier", "sousAgent", "terminal", "reglage", "action"];

/** Identifiant unique dans la palette. */
export function idElement(s: Pick<Source, "genre" | "id">): string {
  return `${s.genre}:${s.id}`;
}

function element(s: Source, marquesTitre?: number[], marquesDetail?: number[]): ElementPalette {
  return {
    id: idElement(s),
    icone: s.icone,
    titre: s.titre,
    marquesTitre,
    detail: s.detail,
    marquesDetail,
    indication: s.indication,
    groupe: GROUPES[s.genre].titre,
  };
}

/** Éléments à afficher : tout par groupes (requête vide), sinon ce qui correspond, groupe le mieux trouvé d'abord. */
export function elementsAller(requete: string, sources: Source[]): ElementPalette[] {
  const parGroupe = new Map<string, { meilleur: number; rang: number; liste: { s: Source; score: number; el: ElementPalette }[] }>();
  const vide = !termesDe(requete).length;
  for (const s of sources) {
    let score = 0;
    let el: ElementPalette;
    if (vide) {
      if (s.seulementSiCherche) continue;
      el = element(s);
    } else {
      const dansTitre = correspondance(requete, s.titre);
      const dansDetail = dansTitre ? null : s.detail ? correspondance(requete, s.detail) : null;
      // Mots répartis entre le titre et le détail (« reglages raccourcis »).
      const ensemble = dansTitre || dansDetail ? null : correspondance(requete, `${s.titre} ${s.detail ?? ""} ${s.cle ?? ""}`);
      if (dansTitre) {
        score = dansTitre.score;
        el = element(s, dansTitre.positions);
      } else if (dansDetail) {
        score = dansDetail.score / 2;
        el = element(s, undefined, dansDetail.positions);
      } else if (ensemble) {
        score = ensemble.score / 2;
        const n = s.titre.length + 1;
        const d = (s.detail ?? "").length;
        el = element(s, ensemble.positions.filter((p) => p < n), ensemble.positions.filter((p) => p >= n && p < n + d).map((p) => p - n));
      } else continue;
    }
    const titre = GROUPES[s.genre].titre;
    const g = parGroupe.get(titre) ?? { meilleur: -Infinity, rang: ORDRE.indexOf(s.genre), liste: [] };
    g.meilleur = Math.max(g.meilleur, score);
    g.liste.push({ s, score, el });
    parGroupe.set(titre, g);
  }
  const groupes = [...parGroupe.values()].sort((a, b) => (vide ? a.rang - b.rang : b.meilleur - a.meilleur || a.rang - b.rang));
  const sortie: ElementPalette[] = [];
  const vus = new Set<string>();
  for (const g of groupes) {
    const limite = vide ? GROUPES[g.liste[0].s.genre].vide : GROUPES[g.liste[0].s.genre].plein;
    g.liste.sort((a, b) => b.score - a.score || a.s.ordre - b.s.ordre);
    let n = 0;
    for (const x of g.liste) {
      if (n >= limite) break;
      if (vus.has(x.el.id)) continue;
      vus.add(x.el.id);
      sortie.push(x.el);
      n += 1;
    }
  }
  return sortie;
}

/** Positions (indices) des mots de la requête dans un extrait, sans casse ni accents. */
export function marquesExtrait(extrait: string, requete: string): number[] {
  const plie = plier(extrait);
  const marques = new Set<number>();
  for (const terme of termesDe(requete)) {
    for (let i = plie.indexOf(terme); i >= 0; i = plie.indexOf(terme, i + terme.length)) {
      for (let k = 0; k < terme.length; k++) marques.add(i + k);
    }
  }
  return [...marques].sort((a, b) => a - b);
}

/** Terminaux d'un dossier, lus dans le stockage du panneau Terminal (mêmes titres que ses onglets). */
export function terminauxDuDossier(dossier: string): { id: string; titre: string }[] {
  try {
    const brut = typeof localStorage === "undefined" ? null : localStorage.getItem(`axecode:terminals:${dossier}`);
    const liste = brut ? (JSON.parse(brut) as { index?: number; title?: string; customTitle?: string }[]) : [];
    if (!Array.isArray(liste)) return [];
    return liste
      .filter((t) => t && Number.isInteger(t.index) && typeof t.title === "string")
      .map((t) => {
        const titre =
          typeof t.customTitle === "string" && t.customTitle
            ? t.customTitle
            : isExecutablePathTitle(t.title!)
              ? `Terminal ${t.index}`
              : t.title!;
        return { id: `terminal-${t.index}`, titre };
      });
  } catch {
    return [];
  }
}

function memeChemin(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** Où ouvrir une conversation : dans le dossier ouvert, en conversation sans dossier, ou en ouvrant son dossier. */
export function ouOuvrir(dossierConversation: string, dossierOuvert: string | undefined, racineLibre: string): "ici" | "libre" | "dossier" {
  if (dossierOuvert && memeChemin(dossierConversation, dossierOuvert)) return "ici";
  if (racineLibre && memeChemin(dossierConversation, racineLibre)) return "libre";
  return "dossier";
}

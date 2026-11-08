// Lot palette (P3) — recherche dans les Réglages : sections et réglages par mot, sans tenir
// compte de la casse ni des accents. Index écrit d'après les volets (titres visibles) ; le
// test tests/rechercheReglages.test.cjs vérifie que chaque titre existe bien dans le code de
// sa section. Les raccourcis viennent du registre (src/axe/raccourcis.ts).
import { RACCOURCIS } from "../../axe/raccourcis";
import { demanderSectionReglages } from "../../lib/sectionReglages";
import { plier, termesDe } from "./flou";
import { SECTIONS_REGLAGES, type SectionReglages } from "./indexReglages";

export type ReglageConnu = { section: string; titre: string; motsCles?: string };

/** Mots qui mènent à une section entière. */
export const MOTS_SECTIONS: Record<string, string> = {
  about: "version mise à jour axecode",
  appearance: "thème couleurs fond zoom texte",
  providers: "modèles comptes abonnement connexion clé api",
  mcp: "serveurs outils",
  skills: "recettes compétences",
  harness: "harnais mémoires notes affinages affiner",
  repl: "python noyau kernel outils",
  service: "démon arrière-plan",
  connections: "appareils ssh distant",
  shortcuts: "clavier touches",
  voice: "voix micro whisper dictée",
};

export const REGLAGES: ReglageConnu[] = [
  { section: "about", titre: "Version", motsCles: "mise à jour numéro" },
  { section: "appearance", titre: "Préréglages", motsCles: "thème couleur fond sombre clair" },
  { section: "appearance", titre: "Couleur libre", motsCles: "thème fond teinte" },
  { section: "appearance", titre: "Taille du texte du chat et des documents", motsCles: "police lecture agrandir" },
  { section: "appearance", titre: "Zoom de l'interface", motsCles: "agrandir réduire échelle" },
  { section: "providers", titre: "Anthropic", motsCles: "claude abonnement oauth compte connexion" },
  { section: "providers", titre: "OpenAI", motsCles: "chatgpt gpt codex abonnement compte connexion" },
  { section: "providers", titre: "Google", motsCles: "gemini compte connexion" },
  { section: "providers", titre: "Fournisseurs configurables", motsCles: "ollama lm studio mistral deepseek local api" },
  { section: "mcp", titre: "Serveurs MCP", motsCles: "outils serveur oauth" },
  { section: "mcp", titre: "Ajouter un serveur", motsCles: "catalogue" },
  { section: "skills", titre: "Nouvelle recette", motsCles: "skill markdown créer" },
  { section: "harness", titre: "Affinages", motsCles: "affiner mémoires notes" },
  { section: "harness", titre: "Sauvegarde périodique", motsCles: "sauvegarde copie harnais" },
  { section: "repl", titre: "Outils du REPL", motsCles: "modules python noyau kernel" },
  { section: "repl", titre: "Compactage automatique", motsCles: "compacter seuil contexte" },
  { section: "repl", titre: "Plafond de sortie par modèle (max_tokens)", motsCles: "jetons limite" },
  { section: "repl", titre: "Sortie renvoyée au modèle par exécution", motsCles: "troncature caractères" },
  { section: "repl", titre: "Sous-agents", motsCles: "rlm modèle par défaut" },
  { section: "repl", titre: "Recherche web (web.search)", motsCles: "internet fournisseur clé" },
  { section: "repl", titre: "Génération d'images (images.generate)", motsCles: "image dessin" },
  { section: "repl", titre: "API personnalisées (images et vidéos)", motsCles: "vidéo comfyui" },
  { section: "voice", titre: "Modèle", motsCles: "whisper transcription taille micro" },
  { section: "voice", titre: "Mots appris", motsCles: "vocabulaire dictée" },
  { section: "voice", titre: "Vocabulaire", motsCles: "mots appris dictée" },
  { section: "voice", titre: "Options", motsCles: "dictée" },
];

/** Index complet : réglages écrits ici + chaque raccourci du registre (section Raccourcis),
 *  seulement pour les sections présentes dans le volet. */
export function tousLesReglages(): ReglageConnu[] {
  const raccourcis = RACCOURCIS.map((r) => ({ section: "shortcuts", titre: r.libelle, motsCles: `raccourci ${r.combinaison}` }));
  return [...REGLAGES, ...raccourcis].filter((r) => SECTIONS_REGLAGES.some((s) => s.id === r.section));
}

export type ReglageTrouve = { reglage: ReglageConnu; score: number; marques: number[] };
export type SectionTrouvee = { section: SectionReglages; score: number; marques: number[]; reglages: ReglageTrouve[] };

function positions(texte: string, termes: string[]): number[] {
  const plie = plier(texte);
  const marques = new Set<number>();
  for (const t of termes) {
    const i = plie.indexOf(t);
    if (i >= 0) for (let k = 0; k < t.length; k++) marques.add(i + k);
  }
  return [...marques].sort((a, b) => a - b);
}

/** Note d'un mot dans un texte plié : début > début de mot > ailleurs ; -1 s'il n'y est pas. */
function note(plie: string, t: string): number {
  const i = plie.indexOf(t);
  if (i < 0) return -1;
  if (i === 0) return 3;
  return /[\s'(/.-]/.test(plie[i - 1]) ? 2 : 1;
}

/**
 * Sections et réglages qui contiennent TOUS les mots (dans le titre du réglage, celui de sa
 * section ou ses mots-clés). Sections dans l'ordre du volet, réglages les mieux trouvés d'abord.
 */
export function chercherReglages(requete: string, reglages: ReglageConnu[] = tousLesReglages()): SectionTrouvee[] {
  const termes = termesDe(requete);
  if (!termes.length) return [];
  const sortie: SectionTrouvee[] = [];
  for (const section of SECTIONS_REGLAGES) {
    const titreSection = plier(section.titre);
    const motsSection = plier(MOTS_SECTIONS[section.id] ?? "");
    const sectionSeule = termes.every((t) => titreSection.includes(t) || motsSection.includes(t));
    const trouves: ReglageTrouve[] = [];
    for (const reglage of reglages) {
      if (reglage.section !== section.id) continue;
      const titre = plier(reglage.titre);
      const mots = plier(reglage.motsCles ?? "");
      let score = 0;
      let ok = true;
      for (const t of termes) {
        const n = note(titre, t);
        if (n >= 0) score += 10 + n;
        else if (mots.includes(t)) score += 4;
        else if (titreSection.includes(t) || motsSection.includes(t)) score += 1;
        else {
          ok = false;
          break;
        }
      }
      // Un réglage trouvé seulement par le nom de sa section n'est pas listé (la section l'est).
      if (ok && score > termes.length) trouves.push({ reglage, score, marques: positions(reglage.titre, termes) });
    }
    if (!sectionSeule && !trouves.length) continue;
    trouves.sort((a, b) => b.score - a.score);
    sortie.push({ section, score: sectionSeule ? 1 : 0, marques: positions(section.titre, termes), reglages: trouves });
  }
  return sortie;
}

/** Élément du volet ouvert qui affiche `titre` (titre de carte, libellé…), ou null. */
export function elementDuReglage(racine: ParentNode, titre: string): HTMLElement | null {
  const voulu = plier(titre.trim());
  let approchant: HTMLElement | null = null;
  for (const el of Array.from(racine.querySelectorAll<HTMLElement>("h1, h2, h3, h4, legend, label, strong, span, p, td, th, div, button"))) {
    if (el.childElementCount > 4) continue;
    const texte = plier((el.textContent ?? "").replace(/\s+/g, " ").trim());
    if (texte === voulu) return el;
    if (!approchant && texte.startsWith(voulu) && texte.length <= voulu.length + 40) approchant = el;
  }
  return approchant;
}

/** Fait défiler jusqu'au réglage et le signale un instant (le volet vient peut-être de changer). */
export function signalerReglage(titre: string, essais = 30): void {
  if (typeof document === "undefined") return;
  const racine = document.querySelector(".settings-pane__main");
  const el = racine ? elementDuReglage(racine, titre) : null;
  if (!el) {
    if (essais > 0) window.setTimeout(() => signalerReglage(titre, essais - 1), 60);
    return;
  }
  el.scrollIntoView?.({ block: "center" });
  el.classList.add("recherche-reglages__cible");
  window.setTimeout(() => el.classList.remove("recherche-reglages__cible"), 1600);
}

/** Depuis n'importe où (Ctrl+K) : ouvre la section des Réglages, puis signale le réglage. */
export function allerAuReglage(section: string, titre?: string): void {
  demanderSectionReglages(section);
  if (titre) signalerReglage(titre);
}

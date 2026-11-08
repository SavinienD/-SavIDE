// Worktrees — logique pure (testée par tests/worktrees.test.cjs) : noms de
// branche, réglages locaux par dépôt, regroupement de la liste, nettoyage, formats.

/** Nom de branche ou de dossier tiré d'un titre : minuscules, sans accents, tirets, 48 caractères au plus (même règle que le Rust). */
export function slug(texte: string): string {
  let sortie = "";
  let tiret = false;
  for (const c of texte) {
    const m = /[A-Za-z0-9]/.test(c) ? c.toLowerCase() : sansAccent(c);
    if (m) {
      sortie += m;
      tiret = false;
    } else if (sortie && !tiret) {
      sortie += "-";
      tiret = true;
    }
    if (sortie.length >= 48) break;
  }
  const propre = sortie.replace(/^-+|-+$/g, "");
  return propre || "tache";
}

const ACCENTS: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", À: "a", Á: "a", Â: "a", Ã: "a", Ä: "a", Å: "a",
  ç: "c", Ç: "c", è: "e", é: "e", ê: "e", ë: "e", È: "e", É: "e", Ê: "e", Ë: "e",
  ì: "i", í: "i", î: "i", ï: "i", Ì: "i", Í: "i", Î: "i", Ï: "i", ñ: "n", Ñ: "n",
  ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o", Ò: "o", Ó: "o", Ô: "o", Õ: "o", Ö: "o", Ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u", Ù: "u", Ú: "u", Û: "u", Ü: "u", ý: "y", ÿ: "y", Ý: "y",
  œ: "oe", Œ: "oe", æ: "ae", Æ: "ae", ß: "ss",
};
function sansAccent(c: string): string {
  return ACCENTS[c] ?? "";
}

/** Même dossier, quelle que soit l'écriture (\\?\, barres, casse sous Windows). */
export function memeChemin(a: string, b: string): boolean {
  const n = (p: string) => p.replace(/^\\\\\?\\/, "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
}

/** Dernier segment d'un chemin. */
export function nomDe(chemin: string): string {
  const propre = chemin.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const i = Math.max(propre.lastIndexOf("/"), propre.lastIndexOf("\\"));
  return i >= 0 ? propre.slice(i + 1) || propre : propre;
}

/** Chemin affiché (sans le préfixe Windows \\?\). */
export function cheminAffiche(chemin: string): string {
  return chemin.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
}

// ---------------------------------------------------------------------------
// Réglages locaux (stockage de l'appli) : branche de base par dépôt, accord
// sur les commandes du projet, épingles, liens PR / issue, endormis, archives.

export const CLE_REGLAGES = "worktrees.v1";

export type Archive = { depot: string; branche: string; titre: string; dossier: string; dateMs: number; lien?: string };
export type ReglagesDepot = { base?: string; approuve?: string };
export type Reglages = {
  depots: Record<string, ReglagesDepot>;
  epingles: string[];
  liens: Record<string, string>;
  endormis: string[];
  archives: Archive[];
};

export type Stockage = { getItem(cle: string): string | null; setItem(cle: string, valeur: string): void };

export function reglagesVides(): Reglages {
  return { depots: {}, epingles: [], liens: {}, endormis: [], archives: [] };
}

export function lireReglages(s: Stockage | null | undefined): Reglages {
  const vide = reglagesVides();
  try {
    const brut = s?.getItem(CLE_REGLAGES);
    if (!brut) return vide;
    const r = JSON.parse(brut) as Partial<Reglages>;
    return {
      depots: r.depots && typeof r.depots === "object" ? r.depots : {},
      epingles: Array.isArray(r.epingles) ? r.epingles.filter((x) => typeof x === "string") : [],
      liens: r.liens && typeof r.liens === "object" ? r.liens : {},
      endormis: Array.isArray(r.endormis) ? r.endormis.filter((x) => typeof x === "string") : [],
      archives: Array.isArray(r.archives) ? r.archives.filter((a) => a && typeof a.branche === "string") : [],
    };
  } catch {
    return vide;
  }
}

export function ecrireReglages(s: Stockage | null | undefined, r: Reglages): void {
  try {
    s?.setItem(CLE_REGLAGES, JSON.stringify(r));
  } catch {
    // stockage plein ou coupé : le réglage vaut pour la session
  }
}

function cleDepot(r: Reglages, depot: string): string {
  return Object.keys(r.depots).find((k) => memeChemin(k, depot)) ?? depot;
}

export function reglagesDepot(r: Reglages, depot: string): ReglagesDepot {
  return r.depots[cleDepot(r, depot)] ?? {};
}

export function avecReglagesDepot(r: Reglages, depot: string, maj: Partial<ReglagesDepot>): Reglages {
  const cle = cleDepot(r, depot);
  const suivant: ReglagesDepot = { ...(r.depots[cle] ?? {}), ...maj };
  for (const k of Object.keys(suivant) as (keyof ReglagesDepot)[]) if (!suivant[k]) delete suivant[k];
  return { ...r, depots: { ...r.depots, [cle]: suivant } };
}

/** Branche de départ : réglage du dépôt, puis worktrees.toml, puis branche principale. */
export function baseParDefaut(r: Reglages, depot: string, baseFichier: string | null, principale: string | null, branches: string[]): string {
  const choix = [reglagesDepot(r, depot).base, baseFichier ?? undefined, principale ?? undefined];
  for (const b of choix) if (b && (branches.length === 0 || branches.includes(b) || b.includes("/"))) return b;
  return branches[0] ?? "HEAD";
}

/** Les commandes du projet (empreinte) ont-elles déjà l'accord de l'utilisateur ? */
export function commandesApprouvees(r: Reglages, depot: string, empreinte: string | null): boolean {
  return !empreinte || reglagesDepot(r, depot).approuve === empreinte;
}

export function basculer(liste: string[], chemin: string): string[] {
  return liste.some((x) => memeChemin(x, chemin)) ? liste.filter((x) => !memeChemin(x, chemin)) : [...liste, chemin];
}

export function contient(liste: string[], chemin: string): boolean {
  return liste.some((x) => memeChemin(x, chemin));
}

export function lienDe(r: Reglages, dossier: string): string | undefined {
  const cle = Object.keys(r.liens).find((k) => memeChemin(k, dossier));
  return cle ? r.liens[cle] : undefined;
}

export function avecLien(r: Reglages, dossier: string, url: string): Reglages {
  const liens = { ...r.liens };
  for (const k of Object.keys(liens)) if (memeChemin(k, dossier)) delete liens[k];
  const propre = url.trim();
  if (propre) liens[dossier] = propre;
  return { ...r, liens };
}

/** Adresse acceptée pour un lien de PR ou d'issue (http ou https seulement). */
export function urlValide(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Ordre d'un groupe : dossier principal, puis épinglés, puis les autres (par nom). */
export function ordonnerWorktrees<T extends { dossier: string; nom: string; principal: boolean }>(liste: T[], epingles: string[]): T[] {
  const rang = (w: T) => (w.principal ? 0 : contient(epingles, w.dossier) ? 1 : 2);
  return [...liste].sort((a, b) => rang(a) - rang(b) || a.nom.localeCompare(b.nom, "fr"));
}

/** Libellé court d'un lien : « PR #12 », « Issue #34 », sinon le nom de domaine. */
export function libelleLien(url: string): string {
  const m = /\/(pull|pulls|merge_requests|issues|issue)\/(\d+)/.exec(url);
  if (m) return `${m[1].startsWith("issue") ? "Issue" : "PR"} #${m[2]}`;
  const linear = /linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i.exec(url);
  if (linear) return linear[1].toUpperCase();
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Formats

export function tailleLisible(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  const unites = ["Ko", "Mo", "Go", "To"];
  let v = octets / 1024;
  let i = 0;
  while (v >= 1024 && i < unites.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1).replace(".", ",")} ${unites[i]}`;
}

export function ilYa(ms: number | null | undefined, maintenant: number): string {
  if (!ms) return "jamais";
  const s = Math.max(0, Math.round((maintenant - ms) / 1000));
  if (s < 60) return "à l'instant";
  const min = Math.round(s / 60);
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const j = Math.round(h / 24);
  return j === 1 ? "hier" : `il y a ${j} jours`;
}

/** Âge en jours (arrondi vers le bas). */
export function joursDepuis(ms: number | null | undefined, maintenant: number): number {
  if (!ms) return Number.POSITIVE_INFINITY;
  return Math.floor((maintenant - ms) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Tâches de fond

type TacheEtapes = { genre: string; etapes: string[]; etape: string; etat: string };

/** Étapes affichées d'une tâche : libellé, et état (fait, en cours, à venir, échec). */
export function etapesAffichees(t: TacheEtapes): { cle: string; libelle: string; etat: "fait" | "cours" | "avenir" | "echec" }[] {
  const libelles: Record<string, string> =
    t.genre === "creation"
      ? { git: "Branche et dossier", partage: "Partage", script: "Préparation" }
      : { script: "Script de suppression", git: t.genre === "archivage" ? "Retrait du dossier" : "Suppression" };
  const visibles = t.etapes.filter((e) => e !== "fin");
  const courant = visibles.indexOf(t.etape);
  return visibles.map((e, i) => {
    let etat: "fait" | "cours" | "avenir" | "echec" = "avenir";
    if (t.etape === "fin" || t.etat === "reussi" || (courant >= 0 && i < courant)) etat = "fait";
    else if (i === courant) etat = t.etat === "en_cours" ? "cours" : t.etat === "echec" ? "echec" : "avenir";
    return { cle: e, libelle: libelles[e] ?? e, etat };
  });
}

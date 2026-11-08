// skills de Claude Code, Codex et ~/.agents repris dans le harnais,
// et skills installés depuis une adresse (git ou .zip). Module pur : libellés,
// groupes, sélection. Testé par tests/interopSkills.test.cjs.

export type OutilSkill = "claude_code" | "codex" | "agents" | "url";
export type EtatSkill = "nouveau" | "importe" | "installe" | "mise_a_jour" | "conflit";

export type SkillExterne = {
  chemin: string;
  nom: string;
  nomSource: string;
  description: string;
  outil: OutilSkill;
  portee: "global" | "project";
  racine: string;
  fichiers: number;
  octets: number;
  empreinte: string;
  etat: EtatSkill;
  idHarnais?: string | null;
};

export type ApercuSkill = {
  sousDossier: string;
  nom: string;
  nomSource: string;
  description: string;
  version?: string | null;
  fichiers: string[];
  octets: number;
  extrait: string;
  etat: EtatSkill;
  idHarnais?: string | null;
  versionInstallee?: string | null;
};

export type ApercuUrl = { jeton: string; url: string; genre: "git" | "zip"; version: string; skills: ApercuSkill[] };

export type SkillInstalle = {
  id: string;
  scope: "global" | "project";
  url: string;
  sousDossier?: string | null;
  version?: string | null;
  importeLe: number;
};

export type RapportImport = { faits: string[]; erreurs: string[] };

const OUTILS: Record<OutilSkill, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  agents: "Agent Skills",
  url: "Adresse",
};

export const libelleOutil = (o: OutilSkill): string => OUTILS[o] ?? o;

/** État d'un skill, en clair. */
export function libelleEtat(etat: EtatSkill): string {
  switch (etat) {
    case "nouveau":
      return "nouveau";
    case "importe":
      return "déjà importé";
    case "installe":
      return "installé";
    case "mise_a_jour":
      return "mise à jour disponible";
    default:
      return "nom déjà pris";
  }
}

/** Seuls les skills nouveaux ou à mettre à jour se cochent. */
export const cochable = (etat: EtatSkill): boolean => etat === "nouveau" || etat === "mise_a_jour";

/** Sélection de départ : les nouveaux et les mises à jour. */
export function selectionInitiale<T extends { etat: EtatSkill }>(liste: T[], cle: (s: T) => string): Set<string> {
  return new Set(liste.filter((s) => cochable(s.etat)).map(cle));
}

/** Skills regroupés par dossier source, dans l'ordre reçu. */
export function grouperParRacine(liste: SkillExterne[]): { racine: string; outil: OutilSkill; skills: SkillExterne[] }[] {
  const groupes: { racine: string; outil: OutilSkill; skills: SkillExterne[] }[] = [];
  for (const s of liste) {
    let g = groupes.find((x) => x.racine === s.racine);
    if (!g) {
      g = { racine: s.racine, outil: s.outil, skills: [] };
      groupes.push(g);
    }
    g.skills.push(s);
  }
  return groupes;
}

/** Nombre de mises à jour proposées (badge du bouton). */
export const nombreMisesAJour = (liste: { etat: EtatSkill }[]): number => liste.filter((s) => s.etat === "mise_a_jour").length;

/** Taille lisible (Ko / Mo). */
export function taille(octets: number): string {
  if (octets < 1024) return `${octets} o`;
  if (octets < 1024 * 1024) return `${Math.round(octets / 1024)} Ko`;
  return `${(octets / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}

/** Vérification rapide avant d'appeler le service (le service revérifie). */
export function adresseValide(url: string): string | null {
  const u = url.trim();
  if (!u) return "Collez l'adresse d'un dépôt git ou d'une archive .zip.";
  if (!/^https?:\/\//i.test(u)) return "L'adresse doit commencer par https://";
  return null;
}

/** Version affichée : version du skill, puis commit ou empreinte de l'archive. */
export function libelleVersion(skill: { version?: string | null }, apercu: { genre: string; version: string }): string {
  const source = apercu.genre === "git" ? `révision ${apercu.version}` : `archive ${apercu.version}`;
  return skill.version ? `version ${skill.version} · ${source}` : source;
}

/** Texte de fin d'import (« 2 skills importés, 1 erreur »). */
export function resumeRapport(r: RapportImport, verbe = "importé"): string {
  const n = r.faits.length;
  const morceaux = [`${n} skill${n > 1 ? "s" : ""} ${verbe}${n > 1 ? "s" : ""}`];
  if (r.erreurs.length) morceaux.push(`${r.erreurs.length} erreur${r.erreurs.length > 1 ? "s" : ""} : ${r.erreurs.join(" ; ")}`);
  return morceaux.join(", ");
}

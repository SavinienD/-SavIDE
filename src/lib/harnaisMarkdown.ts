// partager une entrée du harnais en .md.
// Fonctions pures : mise en forme Markdown (export), relecture (import), garde-fou des secrets,
// sélection multiple de la liste. L'interface est dans components/settings/HarnaisPartage.tsx.
//
// Format (lisible par un humain, réimportable) :
//   ---
//   format: harnais-md/1
//   type: memory  # Mémoire
//   titre: "…"          (chaîne JSON, donc YAML valide)
//   portee: global
//   tags: ["a", "b"]
//   modifie: <date ISO de la dernière modification>
//   date: <date ISO de l'export>
//   version: <version de l'appli>
//   ---
//
//   <corps tel quel>
//   (skill : <!-- harnais-md:code --> puis le code Python dans un bloc ```python)
// Plusieurs entrées : UN seul .md (en-tête commun, puis chaque entrée précédée de la ligne
// <!-- harnais-md:entree --> et de son propre en-tête). Un .md se lit partout (messagerie,
// e-mail, Obsidian) sans rien extraire, ce que ne permet pas un .zip.

export type GenreHarnais = "prompt_note" | "memory" | "skill" | "subagent_spec";
export type PorteeHarnais = "global" | "project";

export const FORMAT_HARNAIS = "harnais-md/1";
export const MARQUE_ENTREE = "<!-- harnais-md:entree -->";
export const MARQUE_CODE = "<!-- harnais-md:code -->";
export const MASQUE = "[secret masqué]";

export const LIBELLE_GENRE: Record<GenreHarnais, string> = {
  prompt_note: "Note de prompt",
  memory: "Mémoire",
  skill: "Skill Python",
  subagent_spec: "Profil de sous-agent",
};

export type EntreeAExporter = {
  kind: GenreHarnais;
  scope: PorteeHarnais;
  title: string;
  tags: string[];
  body: string;
  updated?: number;
  /** Skills : contenu de `__init__.py` (absent = code non disponible). */
  code?: string | null;
};

export type EntreeLue = {
  kind: GenreHarnais;
  /** null : le fichier n'impose pas de portée (choisie à l'import). */
  scope: PorteeHarnais | null;
  title: string;
  tags: string[];
  body: string;
  code: string | null;
};

export type LectureHarnais = { ok: true; entrees: EntreeLue[] } | { ok: false; erreur: string };

// ---- Nom du fichier --------------------------------------------------------------

function sansAccents(texte: string): string {
  return texte.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Titre en kebab-case (sans accents ni ponctuation, 60 caractères au plus). */
export function kebab(titre: string): string {
  const k = sansAccents(titre)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return k || "entree-harnais";
}

/** Nom proposé dans la boîte d'enregistrement : titre en kebab-case, ou harnais-N-entrees.md. */
export function nomFichierHarnais(entrees: { title: string }[]): string {
  if (entrees.length === 1) return `${kebab(entrees[0].title)}.md`;
  return `harnais-${entrees.length}-entrees.md`;
}

// ---- Export ----------------------------------------------------------------------

function dateIso(ms: number | undefined): string | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function enteteEntree(e: EntreeAExporter): string[] {
  const lignes = [
    `type: ${e.kind}  # ${LIBELLE_GENRE[e.kind] ?? e.kind}`,
    `titre: ${JSON.stringify(e.title)}`,
    `portee: ${e.scope}`,
    `tags: [${e.tags.map((t) => JSON.stringify(t)).join(", ")}]`,
  ];
  const modifie = dateIso(e.updated);
  if (modifie) lignes.push(`modifie: ${modifie}`);
  return lignes;
}

/** Clôture de bloc plus longue que toute suite de ` du code (le code peut contenir ```). */
function cloture(code: string): string {
  const plusLongue = Math.max(0, ...(code.match(/`+/g) ?? []).map((s) => s.length));
  return "`".repeat(Math.max(3, plusLongue + 1));
}

function corpsEntree(e: EntreeAExporter): string {
  let corps = e.body;
  if (e.kind === "skill" && typeof e.code === "string") {
    const code = e.code.endsWith("\n") ? e.code : `${e.code}\n`;
    const f = cloture(code);
    corps += `\n\n${MARQUE_CODE}\n## Code Python (\`__init__.py\`)\n\n${f}python\n${code}${f}`;
  }
  return corps;
}

export type OptionsExport = { version: string | null; date: Date };

/** Markdown d'une ou plusieurs entrées (plusieurs = un seul fichier, une section par entrée). */
export function harnaisVersMarkdown(entrees: EntreeAExporter[], options: OptionsExport): string {
  const pied = [`date: ${options.date.toISOString()}`, ...(options.version ? [`version: ${options.version}`] : [])];
  if (entrees.length === 1) {
    const e = entrees[0];
    return ["---", `format: ${FORMAT_HARNAIS}`, ...enteteEntree(e), ...pied, "---", "", corpsEntree(e), ""].join("\n");
  }
  const morceaux = [
    ["---", `format: ${FORMAT_HARNAIS}`, `entrees: ${entrees.length}`, ...pied, "---", "", `# Harnais : ${entrees.length} entrées`, ""].join("\n"),
  ];
  for (const e of entrees) {
    morceaux.push([MARQUE_ENTREE, "---", ...enteteEntree(e), "---", "", corpsEntree(e), ""].join("\n"));
  }
  return morceaux.join("\n");
}

// ---- Import ----------------------------------------------------------------------

const ALIAS_GENRE: Record<string, GenreHarnais> = {
  prompt_note: "prompt_note", note: "prompt_note", "note de prompt": "prompt_note", plan: "prompt_note",
  memory: "memory", memoire: "memory", "mémoire": "memory",
  skill: "skill",
  subagent_spec: "subagent_spec", subagent: "subagent_spec", "sous-agent": "subagent_spec", "profil de sous-agent": "subagent_spec",
};

type Yaml = Record<string, string | string[]>;

function valeurYaml(brut: string): string | string[] {
  const v = brut.trim();
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(v)) throw new Error("guillemet non fermé");
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith("[")) {
    try {
      const liste = JSON.parse(v);
      if (Array.isArray(liste)) return liste.map((x) => String(x));
    } catch {
      // liste YAML simple : [a, b]
    }
    if (!v.endsWith("]")) throw new Error("liste non fermée");
    return v
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return v.replace(/\s+#.*$/, "").trim();
}

/** Coupe « ---\nyaml\n---\ncorps » ; null si le texte ne commence pas par un en-tête. */
function couperEntete(texte: string): { yaml: Yaml; corps: string } | { erreur: string } | null {
  const t = texte.replace(/^(?:[ \t]*\n)+/, "");
  if (!/^---[ \t]*\n/.test(t)) return null;
  const lignes = t.split("\n");
  const fin = lignes.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  if (fin < 0) return { erreur: "L'en-tête n'est pas fermé (ligne --- manquante)." };
  const yaml: Yaml = {};
  for (const ligne of lignes.slice(1, fin)) {
    if (!ligne.trim() || ligne.trim().startsWith("#")) continue;
    const m = /^([A-Za-zÀ-ÿ_-]+)\s*:\s*(.*)$/.exec(ligne);
    if (!m) return { erreur: `En-tête illisible : « ${ligne.slice(0, 40)} ».` };
    try {
      yaml[sansAccents(m[1]).toLowerCase()] = valeurYaml(m[2]);
    } catch {
      return { erreur: `En-tête illisible : « ${ligne.slice(0, 40)} ».` };
    }
  }
  let corps = lignes.slice(fin + 1).join("\n");
  corps = corps.replace(/^\n/, "");
  return { yaml, corps };
}

function texteYaml(yaml: Yaml, ...cles: string[]): string {
  for (const c of cles) {
    const v = yaml[c];
    if (typeof v === "string") return v;
  }
  return "";
}

function lireEntree(morceau: string): EntreeLue | string {
  const coupe = couperEntete(morceau);
  if (!coupe) return "Ce fichier n'a pas l'en-tête d'une entrée du harnais (bloc --- avec type et titre au début).";
  if ("erreur" in coupe) return coupe.erreur;
  const { yaml } = coupe;
  const format = texteYaml(yaml, "format");
  if (format && !format.startsWith("harnais-md/")) return `Format « ${format} » inconnu.`;
  if (format && format !== FORMAT_HARNAIS) return `Format « ${format} » trop récent pour cette version de l'appli.`;
  const brutGenre = texteYaml(yaml, "type", "kind");
  const kind = ALIAS_GENRE[brutGenre.toLowerCase()];
  if (!kind) {
    return brutGenre
      ? `Champ « type » inconnu : « ${brutGenre} » (attendu : note, mémoire, skill ou sous-agent).`
      : "Champ « type » manquant dans l'en-tête.";
  }
  const title = texteYaml(yaml, "titre", "title").trim();
  if (!title) return "Entrée sans titre (champ « titre » vide).";
  const brutPortee = texteYaml(yaml, "portee", "scope").toLowerCase();
  const scope: PorteeHarnais | null =
    brutPortee === "global" ? "global" : brutPortee === "project" || brutPortee === "projet" ? "project" : null;
  const tagsBruts = yaml.tags;
  const tags = Array.isArray(tagsBruts) ? tagsBruts : typeof tagsBruts === "string" && tagsBruts ? [tagsBruts] : [];
  let corps = coupe.corps;
  let code: string | null = null;
  const lignes = corps.split("\n");
  const marque = lignes.lastIndexOf(MARQUE_CODE);
  if (marque >= 0) {
    const apres = lignes.slice(marque + 1);
    const ouverture = apres.findIndex((l) => /^`{3,}python\s*$/.test(l));
    const f = ouverture >= 0 ? /^(`{3,})/.exec(apres[ouverture])![1] : "";
    const fermeture = ouverture >= 0 ? apres.findIndex((l, i) => i > ouverture && l === f) : -1;
    if (fermeture < 0) return "Bloc de code Python mal fermé.";
    code = apres.slice(ouverture + 1, fermeture).join("\n") + "\n";
    corps = lignes.slice(0, marque).join("\n");
  }
  return { kind, scope, title, tags, body: corps.replace(/[\r\n]+$/, ""), code };
}

/** Relit un .md exporté (une ou plusieurs entrées), ou explique pourquoi il est refusé. */
export function lireHarnaisMarkdown(brut: string): LectureHarnais {
  const texte = brut.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!texte.trim()) return { ok: false, erreur: "Le fichier est vide." };
  const lignes = texte.split("\n");
  const marques = lignes.reduce<number[]>((acc, l, i) => (l.trim() === MARQUE_ENTREE ? [...acc, i] : acc), []);
  const morceaux =
    marques.length === 0
      ? [texte]
      : marques.map((debut, k) => lignes.slice(debut + 1, marques[k + 1] ?? lignes.length).join("\n"));
  if (morceaux.length > 500) return { ok: false, erreur: "Trop d'entrées dans ce fichier (500 au plus)." };
  const entrees: EntreeLue[] = [];
  for (const [i, m] of morceaux.entries()) {
    const lu = lireEntree(m);
    if (typeof lu === "string") {
      return { ok: false, erreur: morceaux.length > 1 ? `Entrée ${i + 1} : ${lu}` : lu };
    }
    entrees.push(lu);
  }
  return { ok: true, entrees };
}

// ---- Garde-fou : secrets ---------------------------------------------------------

export type SecretTrouve = { debut: number; fin: number; raison: string; apercu: string };

/** Entropie de Shannon, en bits par caractère. */
export function entropie(texte: string): number {
  const n = new Map<string, number>();
  for (const c of texte) n.set(c, (n.get(c) ?? 0) + 1);
  let h = 0;
  for (const k of n.values()) {
    const p = k / texte.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const melange = (v: string) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v);

type Regle = { raison: string; re: RegExp; groupe?: number; filtre?: (valeur: string) => boolean };

const REGLES: Regle[] = [
  { raison: "clé privée", re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { raison: "clé d'API (sk-…)", re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g },
  { raison: "jeton GitHub", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { raison: "jeton GitLab", re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { raison: "jeton Slack", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { raison: "clé AWS", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { raison: "clé Google", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { raison: "jeton JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { raison: "jeton Bearer", re: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/g, groupe: 1 },
  { raison: "mot de passe dans une adresse", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]+)@/gi, groupe: 1 },
  {
    raison: "valeur d'un mot de passe ou d'un jeton",
    re: /(?:\b(?:password|passwd|pwd|passphrase|mdp|secret|client_secret|token|jeton|api[_ -]?key|apikey|access[_ -]?key)|mot de passe|cl[ée] (?:d'api|api|secrète))\s*[:=]\s*["'`]?([^\s"'`,;]{6,})/gi,
    groupe: 1,
    filtre: (v) => v !== MASQUE && (/\d/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v))),
  },
  {
    raison: "chaîne aléatoire (forte entropie)",
    re: /[A-Za-z0-9+_=-]{24,}/g,
    filtre: (v) => melange(v) && entropie(v) >= 3.8,
  },
];

/** Ce qui ressemble à un secret (plages fusionnées, dans l'ordre du texte). */
export function detecterSecrets(texte: string): SecretTrouve[] {
  const brut: Omit<SecretTrouve, "apercu">[] = [];
  for (const regle of REGLES) {
    regle.re.lastIndex = 0;
    for (const m of texte.matchAll(regle.re)) {
      const valeur = regle.groupe ? m[regle.groupe] : m[0];
      if (!valeur || (regle.filtre && !regle.filtre(valeur))) continue;
      const debut = (m.index ?? 0) + (regle.groupe ? m[0].lastIndexOf(valeur) : 0);
      brut.push({ debut, fin: debut + valeur.length, raison: regle.raison });
    }
  }
  brut.sort((a, b) => a.debut - b.debut || b.fin - a.fin);
  const fusion: Omit<SecretTrouve, "apercu">[] = [];
  for (const s of brut) {
    const dernier = fusion[fusion.length - 1];
    if (dernier && s.debut < dernier.fin) dernier.fin = Math.max(dernier.fin, s.fin);
    else fusion.push({ ...s });
  }
  return fusion.map((s) => ({ ...s, apercu: `${texte.slice(s.debut, s.debut + 4)}…` }));
}

/** Le texte avec chaque secret probable remplacé par « [secret masqué] ». */
export function masquerSecrets(texte: string): string {
  let sortie = texte;
  for (const s of detecterSecrets(texte).reverse()) {
    sortie = sortie.slice(0, s.debut) + MASQUE + sortie.slice(s.fin);
  }
  return sortie;
}

// ---- Sélection multiple de la liste ------------------------------------------------

/** Clic sur une ligne : simple = elle seule ; Ctrl/⌘ = bascule ; Maj = plage depuis l'ancre. */
export function selectionApresClic(
  selection: string[],
  ordre: string[],
  id: string,
  touches: { ctrl?: boolean; shift?: boolean },
  ancre: string | null,
): { selection: string[]; ancre: string | null } {
  if (touches.shift && ancre && ordre.includes(ancre) && ordre.includes(id)) {
    const [a, b] = [ordre.indexOf(ancre), ordre.indexOf(id)].sort((x, y) => x - y);
    return { selection: ordre.slice(a, b + 1), ancre };
  }
  if (touches.ctrl) {
    const dedans = selection.includes(id);
    const suivante = ordre.filter((x) => (x === id ? !dedans : selection.includes(x)));
    return { selection: suivante, ancre: id };
  }
  return { selection: [id], ancre: id };
}

/** Clic droit (ou « ⋯ ») : sur une ligne déjà sélectionnée, toute la sélection ; sinon elle seule. */
export function selectionPourMenu(selection: string[], id: string): string[] {
  return selection.includes(id) ? selection : [id];
}

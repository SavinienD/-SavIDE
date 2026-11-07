/**
 * voix-vocabulaire — vocabulaire de la dictée appris des messages TAPÉS dans
 * SavIDE (noms propres, sigles, termes techniques répétés), gardé sur ce poste
 * (localStorage) et ajouté à l'amorce de Whisper, après les termes saisis à la main.
 *
 * Règles (simples et prudentes) :
 * - un mot est « marqué » s'il porte une majuscule ailleurs qu'en tête (pfSense,
 *   GitLab, GDMS) ou une majuscule initiale hors début de phrase (Grafana, Dupont) ;
 * - il est retenu quand il apparaît dans au moins 2 messages différents ;
 * - jamais de secret : un message qui parle de mot de passe, jeton, clé… est ignoré
 *   en entier ; les liens, adresses, chemins, code et les chaînes qui ressemblent à
 *   une clé (préfixes connus, chiffres mêlés aux lettres, forte entropie) sont écartés ;
 * - sans doublon (casse ignorée), borné (MAX_SUIVIS mots suivis, LIMITE_VOCABULAIRE
 *   caractères envoyés : la taille que le service accepte pour l'amorce) ;
 * - un mot retiré dans les réglages n'est plus réappris.
 */

export type MotSuivi = { forme: string; n: number; vu: number };
export type EtatVocabulaire = {
  version: 1;
  actif: boolean;
  suivis: Record<string, MotSuivi>;
  retires: string[];
};
export type MotAppris = MotSuivi & { cle: string };

/** Taille maximale du vocabulaire ajouté à l'amorce (le service coupe au-delà). */
export const LIMITE_VOCABULAIRE = 400;
/** Nombre de mots suivis (vus au moins une fois) gardés en mémoire. */
export const MAX_SUIVIS = 300;
/** Nombre de messages différents où le mot doit apparaître pour être retenu. */
export const SEUIL_APPRIS = 2;
/** Au-delà, le message est très probablement un collage (journal, code) : ignoré. */
const MAX_MESSAGE = 4000;

/** Déjà dans l'amorce de base de Whisper (voice_rpc BASE_PROMPT) : inutile de les répéter. */
const TERMES_DE_BASE = [
  "savide", "vm", "caddy", "forgejo", "tauri", "jira", "whatsapp",
  "sous-agent", "harness", "worktree", "commit", "push", "installeur",
];

/** Mots courants qui prennent une majuscule sans être des noms propres. */
const MOTS_COURANTS = new Set([
  "ok", "je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "le", "la", "les", "un", "une",
  "des", "et", "ou", "mais", "si", "ça", "ce", "cette", "bonjour", "merci", "salut", "oui", "non",
  "the", "i", "a", "an", "and", "or", "is", "it", "to", "of", "in", "on", "it's", "lol", "svp", "stp",
]);

/** Un message qui contient un de ces mots peut contenir un secret : il n'est pas lu. */
const CONTEXTE_SECRET =
  /(mot[s]? de passe|\bmdp\b|pass(e)?word|passwd|\bpwd\b|\btoken|\bjeton|\bsecret|api[\s_-]?key|cl[ée]s? (api|secr[eè]te|priv[ée]e|ssh|d'acc[eè]s)|\bbearer\b|authorization|identifiant[s]? de connexion|\bcode (pin|d'acc[eè]s|secret)|\bpin\b|\botp\b|\b2fa\b)/i;

const PREFIXES_SECRETS = /^(ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|sk-|sk_|pk_|rk_|xox[abposr]-|akia|asia|aiza|eyj|ya29\.|hf_|npm_|pypi-|shpat_|ssh-|age1)/i;

export function etatVide(): EtatVocabulaire {
  return { version: 1, actif: true, suivis: {}, retires: [] };
}

function entropie(mot: string): number {
  const compte = new Map<string, number>();
  for (const c of mot) compte.set(c, (compte.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of compte.values()) {
    const p = n / mot.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Vrai si la chaîne ressemble à une clé, un jeton, un mot de passe ou un hash. */
export function estSecret(brut: string): boolean {
  const mot = brut.trim();
  if (!mot) return false;
  if (PREFIXES_SECRETS.test(mot)) return true;
  if (/[_=+/\\]/.test(mot)) return true;
  if (/^[0-9a-f-]{12,}$/i.test(mot) && /\d/.test(mot)) return true;
  const chiffres = (mot.match(/\d/g) ?? []).length;
  if (chiffres > 0 && /\p{L}/u.test(mot) && (mot.length > 6 || chiffres > 2)) return true;
  const majInternes = (mot.slice(1).match(/\p{Lu}/gu) ?? []).length;
  const minuscules = (mot.match(/\p{Ll}/gu) ?? []).length;
  if (mot.length >= 12 && majInternes >= 4 && minuscules >= 3) return true;
  if (/^\p{Lu}+$/u.test(mot) && mot.length > 12) return true;
  if (mot.length >= 16 && entropie(mot) >= 3.6) return true;
  return false;
}

/** Texte débarrassé de ce qui n'est pas de la langue tapée : code, liens, adresses. */
function nettoyer(texte: string): string {
  return texte
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, " ")
    .replace(/\bwww\.\S+/gi, " ");
}

function debutDePhrase(avant: string): boolean {
  return avant.trim() === "" || /[.!?…:]["»”)\]]?\s*$/.test(avant) || /\n\s*$/.test(avant);
}

/** Mots marqués d'un message (forme vue), sans doublon de casse. */
export function candidats(message: string): Map<string, string> {
  const trouves = new Map<string, string>();
  if (!message || message.length > MAX_MESSAGE) return trouves;
  const texte = nettoyer(message);
  if (CONTEXTE_SECRET.test(texte)) return trouves;
  for (const m of texte.matchAll(/\S+/g)) {
    let bloc = m[0].replace(/^[\s"'«»“”‘’(\[{<.,;:!?…*]+|[\s"'«»“”‘’)\]}>.,;:!?…*]+$/g, "");
    if (!bloc || /[/\\@#$%&|<>=~^]/.test(bloc) || /\.\p{L}/u.test(bloc)) continue;
    if (estSecret(bloc)) continue;
    // Élision : « d’GitLab » -> « GitLab » (une majuscule après l'apostrophe n'est pas un début de phrase).
    const elision = bloc.split(/['’]/);
    const apresElision = elision.length > 1;
    bloc = elision[elision.length - 1];
    if (!/^\p{L}[\p{L}\p{N}-]*$/u.test(bloc) || bloc.length < 2 || bloc.length > 30) continue;
    if (/-$|--/.test(bloc)) continue;
    const cle = bloc.toLowerCase();
    if (MOTS_COURANTS.has(cle)) continue;
    const majInterne = /\p{Lu}/u.test(bloc.slice(1));
    const majInitiale = /^\p{Lu}/u.test(bloc);
    const debut = !apresElision && debutDePhrase(texte.slice(0, m.index ?? 0));
    if (!majInterne && !(majInitiale && !debut)) continue;
    const dejaVu = trouves.get(cle);
    if (!dejaVu || (estToutMajuscules(dejaVu) && !estToutMajuscules(bloc))) trouves.set(cle, bloc);
  }
  return trouves;
}

function estToutMajuscules(mot: string): boolean {
  return mot.length > 1 && mot === mot.toUpperCase() && mot !== mot.toLowerCase();
}

/** Ajoute les mots d'un message tapé (horodaté `maintenant`) ; renvoie un nouvel état. */
export function apprendre(etat: EtatVocabulaire, message: string, maintenant: number): EtatVocabulaire {
  if (!etat.actif) return etat;
  const trouves = candidats(message);
  if (trouves.size === 0) return etat;
  const retires = new Set(etat.retires);
  const suivis: Record<string, MotSuivi> = { ...etat.suivis };
  for (const [cle, forme] of trouves) {
    if (retires.has(cle)) continue;
    const avant = suivis[cle];
    const garderAncienne = avant && estToutMajuscules(forme) && !estToutMajuscules(avant.forme);
    suivis[cle] = { forme: garderAncienne ? avant.forme : forme, n: (avant?.n ?? 0) + 1, vu: maintenant };
  }
  const cles = Object.keys(suivis);
  if (cles.length > MAX_SUIVIS) {
    cles
      .sort((a, b) => suivis[a].n - suivis[b].n || suivis[a].vu - suivis[b].vu)
      .slice(0, cles.length - MAX_SUIVIS)
      .forEach((cle) => delete suivis[cle]);
  }
  return { ...etat, suivis };
}

/** Mots retenus (vus dans au moins SEUIL_APPRIS messages), les plus fréquents et récents d'abord. */
export function motsAppris(etat: EtatVocabulaire): MotAppris[] {
  if (!etat.actif) return [];
  const retires = new Set(etat.retires);
  return Object.entries(etat.suivis)
    .filter(([cle, mot]) => mot.n >= SEUIL_APPRIS && !retires.has(cle))
    .map(([cle, mot]) => ({ cle, ...mot }))
    .sort((a, b) => b.n - a.n || b.vu - a.vu || a.cle.localeCompare(b.cle));
}

export function retirer(etat: EtatVocabulaire, mot: string): EtatVocabulaire {
  const cle = mot.trim().toLowerCase();
  const suivis = { ...etat.suivis };
  delete suivis[cle];
  const retires = etat.retires.includes(cle) ? etat.retires : [...etat.retires, cle].slice(-MAX_SUIVIS);
  return { ...etat, suivis, retires };
}

/** Oublie tous les mots appris (les mots retirés restent exclus). */
export function toutEffacer(etat: EtatVocabulaire): EtatVocabulaire {
  return { ...etat, suivis: {} };
}

export function avecActif(etat: EtatVocabulaire, actif: boolean): EtatVocabulaire {
  return { ...etat, actif };
}

/** Termes saisis à la main puis mots appris, séparés par des virgules, sans doublon, bornés. */
export function vocabulaireEffectif(manuel: string, etat: EtatVocabulaire, limite = LIMITE_VOCABULAIRE): string {
  const vus = new Set<string>();
  const termes: string[] = [];
  for (const brut of manuel.split(/[,;\n]/)) {
    const terme = brut.trim();
    if (!terme || vus.has(terme.toLowerCase())) continue;
    vus.add(terme.toLowerCase());
    termes.push(terme);
  }
  const base = new Set(TERMES_DE_BASE);
  for (const mot of motsAppris(etat)) {
    if (vus.has(mot.cle) || base.has(mot.cle)) continue;
    vus.add(mot.cle);
    termes.push(mot.forme);
  }
  let texte = "";
  for (const terme of termes) {
    const suite = texte ? `${texte}, ${terme}` : terme;
    if (suite.length > limite) break;
    texte = suite;
  }
  return texte;
}

/** Relit l'état stocké ; tout contenu illisible ou d'une autre forme donne un état vide. */
export function lireEtat(brut: string | null): EtatVocabulaire {
  try {
    if (!brut) return etatVide();
    const lu = JSON.parse(brut) as Partial<EtatVocabulaire>;
    if (!lu || typeof lu !== "object" || !lu.suivis || typeof lu.suivis !== "object" || Array.isArray(lu.suivis)) {
      return etatVide();
    }
    const suivis: Record<string, MotSuivi> = {};
    for (const [cle, mot] of Object.entries(lu.suivis)) {
      if (mot && typeof mot.forme === "string" && typeof mot.n === "number" && typeof mot.vu === "number" && !estSecret(mot.forme)) {
        suivis[cle] = { forme: mot.forme, n: mot.n, vu: mot.vu };
      }
    }
    const retires = Array.isArray(lu.retires) ? lu.retires.filter((r): r is string => typeof r === "string") : [];
    return { version: 1, actif: typeof lu.actif === "boolean" ? lu.actif : true, suivis, retires };
  } catch {
    return etatVide();
  }
}

// ---- Stockage local (navigateur) -------------------------------------------------

export const CLE_VOCABULAIRE = "axe.voix.vocabulaireAuto";
export const EVENEMENT_VOCABULAIRE = "voix:vocabulaire";

export function chargerVocabulaire(): EtatVocabulaire {
  try {
    return lireEtat(window.localStorage.getItem(CLE_VOCABULAIRE));
  } catch {
    return etatVide();
  }
}

export function enregistrerVocabulaire(etat: EtatVocabulaire): void {
  try {
    window.localStorage.setItem(CLE_VOCABULAIRE, JSON.stringify(etat));
  } catch {
    /* stockage plein ou interdit : vocabulaire non conservé */
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENEMENT_VOCABULAIRE));
  } catch {
    /* hors navigateur */
  }
}

/** À l'envoi d'un message tapé : apprend ses mots (jamais bloquant). */
export function apprendreDuMessage(message: string): void {
  try {
    const avant = chargerVocabulaire();
    const apres = apprendre(avant, message, Date.now());
    if (apres !== avant) enregistrerVocabulaire(apres);
  } catch {
    /* l'apprentissage ne doit jamais gêner l'envoi */
  }
}

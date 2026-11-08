// Reprise automatique d'une conversation (ou d'un sous-agent) arrêtée par une limite
// d'abonnement Claude ou ChatGPT : erreur reconnue, heure de reprise tirée des quotas, file des
// reprises prévues (stockage local), garde-fou. Logique pure, testée par
// tests/repriseAuto.test.cjs ; la surveillance (surveillanceReprise.ts) et le bandeau
// (BandeauReprise.tsx) s'en servent.
import type { QuotaReport } from "../quotas";

export type Reprise = {
  sessionId: string;
  /** Session parente : la reprise d'un sous-agent s'affiche dans la conversation qui l'a lancé. */
  parentId: string | null;
  nom: string;
  provider: string;
  /** Heure de la relance (ms Unix). */
  aMs: number;
  /** `quota` : réinitialisation lue dans les quotas ; `defaut` : nouvel essai après un délai. */
  source: "quota" | "defaut";
  /** Reprises automatiques déjà faites pour cette limite. */
  essais: number;
  creeMs: number;
};

export type Precedentes = Record<string, { aMs: number; essais: number }>;

export const CLE_FILE = "reprise.file";
export const CLE_PRECEDENTES = "reprise.precedentes";
/** Après la réinitialisation, une minute de marge (horloges du serveur et du poste). */
export const MARGE_MS = 60_000;
/** Limite sans fenêtre épuisée dans les quotas (pas encore à jour, limite courte) : nouvel essai. */
export const DELAI_DEFAUT_MS = 15 * 60_000;
/** Une limite qui revient moins d'une heure après une reprise automatique compte comme un essai de plus. */
export const FENETRE_ESSAIS_MS = 60 * 60_000;
export const MAX_ESSAIS = 4;
/** Message envoyé à la session au moment de la reprise. */
export const TEXTE_REPRISE =
  "Reprise automatique\u00a0: la limite de l'abonnement est réinitialisée. Continue la tâche là où elle s'est arrêtée.";

const NB = "\u00a0";
const MOTIFS_LIMITE = [
  /\bHTTP 429\b/i,
  /\b429 Too Many Requests\b/i,
  /rate_limit_error/i,
  /\brate limited\b/i,
  /\brate limit\b/i,
  /usage_limit_reached/i,
  /usage limit (?:has been )?reached/i,
  /hit your (?:usage )?limit/i,
];

/** Erreur de tour due à une limite d'utilisation (429, `usage_limit_reached`…). */
export function estLimite(message: string | null | undefined): boolean {
  const texte = String(message ?? "");
  return MOTIFS_LIMITE.some((motif) => motif.test(texte));
}

/** Compte à abonnement dont le quota est lu (Claude ou ChatGPT connectés par leur compte). */
export function estAbonnement(provider: string, report: QuotaReport | null | undefined): boolean {
  return !!report?.providers.some((p) => p.provider === provider && p.supported);
}

/** Fenêtres épuisées : reprise à la plus tardive de leurs réinitialisations (+ marge) ; sinon
 *  nouvel essai après `DELAI_DEFAUT_MS`. */
export function heureReprise(
  provider: string,
  report: QuotaReport | null | undefined,
  maintenant: number,
): { aMs: number; source: "quota" | "defaut" } {
  const compte = report?.providers.find((p) => p.provider === provider && p.supported);
  const fins = (compte?.windows ?? [])
    .filter((w) => w.utilization >= 99.5 && typeof w.resetsAtMs === "number" && w.resetsAtMs > maintenant)
    .map((w) => w.resetsAtMs as number);
  if (fins.length > 0) return { aMs: Math.max(...fins) + MARGE_MS, source: "quota" };
  return { aMs: maintenant + DELAI_DEFAUT_MS, source: "defaut" };
}

/** Numéro de l'essai pour une nouvelle limite de `sessionId`. */
export function essaiSuivant(precedentes: Precedentes, sessionId: string, maintenant: number): number {
  const p = precedentes[sessionId];
  return p && maintenant - p.aMs < FENETRE_ESSAIS_MS ? p.essais + 1 : 0;
}

/** Ajoute (ou remplace) la reprise d'une session. */
export function planifier(file: readonly Reprise[], reprise: Reprise): Reprise[] {
  const i = file.findIndex((r) => r.sessionId === reprise.sessionId);
  if (i < 0) return [...file, reprise];
  const suite = [...file];
  suite[i] = reprise;
  return suite;
}

export function annuler(file: readonly Reprise[], sessionId: string): Reprise[] {
  return file.filter((r) => r.sessionId !== sessionId);
}

/** Reprises arrivées à leur heure : sous-agents d'abord (leur résultat repart vers le parent). */
export function echues(file: readonly Reprise[], maintenant: number): Reprise[] {
  return file
    .filter((r) => r.aMs <= maintenant)
    .sort((a, b) => Number(!a.parentId) - Number(!b.parentId) || a.aMs - b.aMs);
}

/** Reprises montrées dans une conversation : la sienne, puis celles de ses sous-agents. */
export function reprisesDe(file: readonly Reprise[], conversationId: string): Reprise[] {
  const sienne = file.filter((r) => r.sessionId === conversationId);
  const enfants = file.filter((r) => r.parentId === conversationId && r.sessionId !== conversationId).sort((a, b) => a.aMs - b.aMs);
  return [...sienne, ...enfants];
}

const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const deux = (n: number) => String(n).padStart(2, "0");

/** « 15:06 », ou « mar. 15:06 » si ce n'est pas aujourd'hui. */
export function heureCourte(ms: number, maintenant = Date.now()): string {
  const d = new Date(ms);
  const h = `${deux(d.getHours())}:${deux(d.getMinutes())}`;
  return d.toDateString() === new Date(maintenant).toDateString() ? h : `${JOURS[d.getDay()]} ${h}`;
}

export function texteBandeau(r: Reprise, conversationId: string, maintenant = r.creeMs): string {
  const quand = heureCourte(r.aMs, maintenant);
  const action = r.source === "quota" ? `reprise automatique à ${quand}` : `nouvel essai automatique à ${quand}`;
  if (r.sessionId !== conversationId) return `Sous-agent «${NB}${r.nom}${NB}»${NB}: ${action}.`;
  return r.source === "quota" ? `Limite de l'abonnement atteinte${NB}: ${action}.` : `Limite atteinte${NB}: ${action}.`;
}

type Stockage = Pick<Storage, "getItem" | "setItem">;

export function lireFile(stockage: Stockage | null | undefined): Reprise[] {
  try {
    const brut = JSON.parse(stockage?.getItem(CLE_FILE) ?? "[]");
    if (!Array.isArray(brut)) return [];
    return brut
      .filter((r) => r && typeof r.sessionId === "string" && typeof r.aMs === "number" && Number.isFinite(r.aMs))
      .map((r) => ({
        sessionId: r.sessionId,
        parentId: typeof r.parentId === "string" ? r.parentId : null,
        nom: typeof r.nom === "string" ? r.nom : r.sessionId,
        provider: typeof r.provider === "string" ? r.provider : "",
        aMs: r.aMs,
        source: r.source === "defaut" ? "defaut" : "quota",
        essais: typeof r.essais === "number" ? r.essais : 0,
        creeMs: typeof r.creeMs === "number" ? r.creeMs : r.aMs,
      }));
  } catch {
    return [];
  }
}

export function ecrireFile(stockage: Stockage | null | undefined, file: readonly Reprise[]): void {
  try {
    stockage?.setItem(CLE_FILE, JSON.stringify(file));
  } catch {
    /* stockage refusé : la file vit en mémoire jusqu'à la fermeture */
  }
}

export function lirePrecedentes(stockage: Stockage | null | undefined): Precedentes {
  try {
    const brut = JSON.parse(stockage?.getItem(CLE_PRECEDENTES) ?? "{}");
    return brut && typeof brut === "object" && !Array.isArray(brut) ? (brut as Precedentes) : {};
  } catch {
    return {};
  }
}

/** Note une reprise faite ; les notes de plus d'un jour sont oubliées. */
export function noterPrecedente(stockage: Stockage | null | undefined, r: Reprise, maintenant: number): void {
  const toutes = lirePrecedentes(stockage);
  for (const [id, p] of Object.entries(toutes)) if (maintenant - p.aMs > 24 * 3_600_000) delete toutes[id];
  toutes[r.sessionId] = { aMs: maintenant, essais: r.essais };
  try {
    stockage?.setItem(CLE_PRECEDENTES, JSON.stringify(toutes));
  } catch {
    /* stockage refusé */
  }
}

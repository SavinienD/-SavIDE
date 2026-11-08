// Quotas des abonnements Claude et ChatGPT : ce qu'affiche l'indicateur de la barre du haut
// (QuotaIndicator.tsx) et ses alertes. Logique pure, testée par tests/quotas.test.cjs.
//
// Réglages (stockage local) : affichage en % utilisé ou en % restant, seuil d'alerte (80 % utilisés
// par défaut). Une alerte part une fois par fenêtre et par période : la clé porte l'heure de
// réinitialisation, qui change à chaque nouvelle période.

export type QuotaWindow = {
  id: string;
  label: string;
  /** Part utilisée, 0–100. */
  utilization: number;
  resetsAt: string | null;
  /** Réinitialisation (ms Unix), quel que soit le fournisseur. */
  resetsAtMs: number | null;
  windowMinutes: number | null;
  projectedExhaustionMs: number | null;
  exhaustsBeforeReset: boolean;
};

export type ProviderQuota = {
  /** `anthropic`, `openai`, `openai~2` (compte ajouté)… */
  provider: string;
  label: string;
  account: string | null;
  plan: string | null;
  supported: boolean;
  error: string | null;
  windows: QuotaWindow[];
};

export type QuotaReport = { fetchedAtMs: number; providers: ProviderQuota[] };

export type ModeQuota = "utilise" | "restant";
export type ReglagesQuota = { mode: ModeQuota; seuil: number };

export const REGLAGES_QUOTA_DEFAUT: ReglagesQuota = { mode: "utilise", seuil: 80 };
export const CLE_REGLAGES_QUOTA = "quotas.reglages";
export const CLE_ALERTES_QUOTA = "quotas.alertes-vues";
/** Émis sur `window` quand les réglages changent (plusieurs indicateurs peuvent être montés). */
export const EVENEMENT_REGLAGES_QUOTA = "quotas-reglages";
const ALERTES_GARDEES = 50;
const NB = "\u00a0";

type Stockage = Pick<Storage, "getItem" | "setItem">;

export function bornerSeuil(valeur: unknown): number {
  const n = typeof valeur === "number" ? valeur : Number(valeur);
  if (!Number.isFinite(n)) return REGLAGES_QUOTA_DEFAUT.seuil;
  return Math.min(100, Math.max(1, Math.round(n)));
}

export function lireReglagesQuota(stockage: Stockage | null | undefined): ReglagesQuota {
  try {
    const brut = JSON.parse(stockage?.getItem(CLE_REGLAGES_QUOTA) ?? "null") as Partial<ReglagesQuota> | null;
    if (brut && typeof brut === "object") {
      return { mode: brut.mode === "restant" ? "restant" : "utilise", seuil: bornerSeuil(brut.seuil ?? REGLAGES_QUOTA_DEFAUT.seuil) };
    }
  } catch {
    /* réglages illisibles : valeurs par défaut */
  }
  return { ...REGLAGES_QUOTA_DEFAUT };
}

export function ecrireReglagesQuota(stockage: Stockage | null | undefined, reglages: ReglagesQuota): void {
  try {
    stockage?.setItem(CLE_REGLAGES_QUOTA, JSON.stringify({ mode: reglages.mode, seuil: bornerSeuil(reglages.seuil) }));
  } catch {
    /* stockage plein ou refusé : réglage gardé pour cette fois */
  }
}

/** Pourcentage affiché : utilisé, ou restant (100 − utilisé), arrondi. */
export function valeurAffichee(utilisation: number, mode: ModeQuota): number {
  const u = Math.min(100, Math.max(0, Number.isFinite(utilisation) ? utilisation : 0));
  return Math.round(mode === "restant" ? 100 - u : u);
}

/** « 42 % utilisés », « 58 % restants ». */
export function textePourcent(utilisation: number, mode: ModeQuota): string {
  const n = valeurAffichee(utilisation, mode);
  const s = n > 1 ? "s" : "";
  return mode === "restant" ? `${n}${NB}% restant${s}` : `${n}${NB}% utilisé${s}`;
}

/** « Claude », « ChatGPT 2 » (compte ajouté `openai~2`). */
export function nomCompte(p: Pick<ProviderQuota, "provider" | "label">): string {
  const rang = p.provider.includes("~") ? p.provider.split("~")[1] : "";
  return rang ? `${p.label} ${rang}` : p.label;
}

const JOURS = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const deux = (n: number) => String(n).padStart(2, "0");

/** « 15:05 » (aujourd'hui), « mer. 13:00 » (sous 7 jours), sinon « 28/11 13:00 ». */
export function heureReinitialisation(ms: number, maintenant = Date.now()): string {
  const d = new Date(ms);
  const heure = `${deux(d.getHours())}:${deux(d.getMinutes())}`;
  if (d.toDateString() === new Date(maintenant).toDateString()) return heure;
  if (ms > maintenant && ms - maintenant < 7 * 86_400_000) return `${JOURS[d.getDay()]} ${heure}`;
  return `${deux(d.getDate())}/${deux(d.getMonth() + 1)} ${heure}`;
}

/** « dans 30 min », « dans 2 h 05 », « dans 3 j », « maintenant ». */
export function delaiAvant(ms: number, maintenant = Date.now()): string {
  const ecart = ms - maintenant;
  if (ecart <= 0) return "maintenant";
  const min = Math.max(1, Math.round(ecart / 60_000));
  if (min < 60) return `dans ${min}${NB}min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `dans ${h}${NB}h${NB}${deux(min % 60)}`;
  return `dans ${Math.round(h / 24)}${NB}j`;
}

/** Couleur d'une fenêtre : orange dès le seuil, rouge à 90 % (ou au seuil s'il est plus haut)
 *  ou quand le rythme actuel l'épuise avant sa réinitialisation. */
export function ton(w: QuotaWindow, seuil: number): "ok" | "warn" | "error" {
  if (w.utilization >= Math.max(90, seuil) || w.exhaustsBeforeReset) return "error";
  if (w.utilization >= seuil) return "warn";
  return "ok";
}

/** Réinitialisation d'une fenêtre (ms) : `resetsAtMs`, sinon la date RFC 3339 `resetsAt`. */
export function finFenetre(w: Pick<QuotaWindow, "resetsAt" | "resetsAtMs">): number | null {
  if (typeof w.resetsAtMs === "number" && Number.isFinite(w.resetsAtMs)) return w.resetsAtMs;
  const ms = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function comptesAvecQuota(report: QuotaReport | null | undefined): ProviderQuota[] {
  return report?.providers.filter((p) => p.supported) ?? [];
}

/** Fenêtre la plus pleine de tous les comptes (vue compacte). */
export function pireFenetre(report: QuotaReport | null | undefined): { fournisseur: ProviderQuota; fenetre: QuotaWindow } | null {
  let pire: { fournisseur: ProviderQuota; fenetre: QuotaWindow } | null = null;
  for (const fournisseur of comptesAvecQuota(report)) {
    for (const fenetre of fournisseur.windows) {
      if (!pire || fenetre.utilization > pire.fenetre.utilization) pire = { fournisseur, fenetre };
    }
  }
  return pire;
}

export type PartiesCompactes = {
  /** Nom du compte, seulement s'il y a plusieurs comptes avec quota. */
  compte: string | null;
  fenetre: string;
  valeur: string;
  /** Heure de réinitialisation, seulement au-delà du seuil. */
  heure: string | null;
  ton: "ok" | "warn" | "error";
};

/** Vue compacte de la barre du haut : la fenêtre la plus pleine. `null` : aucune fenêtre. */
export function partiesCompactes(
  report: QuotaReport | null | undefined,
  reglages: ReglagesQuota,
  maintenant = Date.now(),
): PartiesCompactes | null {
  const pire = pireFenetre(report);
  if (!pire) return null;
  const { fournisseur, fenetre } = pire;
  const n = valeurAffichee(fenetre.utilization, reglages.mode);
  const fin = finFenetre(fenetre);
  return {
    compte: comptesAvecQuota(report).length > 1 ? nomCompte(fournisseur) : null,
    fenetre: fenetre.label,
    valeur: reglages.mode === "restant" ? `reste ${n}${NB}%` : `${n}${NB}%`,
    heure: fenetre.utilization >= reglages.seuil && fin ? heureReinitialisation(fin, maintenant) : null,
    ton: ton(fenetre, reglages.seuil),
  };
}

/** Texte de la barre du haut : « 5 h 42 % », « ChatGPT 5 h reste 15 % » ; l'heure de
 *  réinitialisation s'ajoute au-delà du seuil (« · 13:30 »). `null` : aucune fenêtre. */
export function texteCompact(report: QuotaReport | null | undefined, reglages: ReglagesQuota, maintenant = Date.now()): string | null {
  const p = partiesCompactes(report, reglages, maintenant);
  if (!p) return null;
  return `${p.compte ? `${p.compte} ` : ""}${p.fenetre} ${p.valeur}${p.heure ? ` · ${p.heure}` : ""}`;
}

export type AlerteQuota = { cle: string; titre: string; texte: string };

/** Fenêtres arrivées au seuil (en % utilisés) et pas encore signalées pour cette période. */
export function alertesQuota(
  report: QuotaReport | null | undefined,
  seuil: number,
  dejaVues: readonly string[],
  maintenant = Date.now(),
): AlerteQuota[] {
  const vues = new Set(dejaVues);
  const alertes: AlerteQuota[] = [];
  for (const p of comptesAvecQuota(report)) {
    for (const w of p.windows) {
      if (w.utilization < seuil) continue;
      const fin = finFenetre(w);
      const cle = `${p.provider}|${w.id}|${fin ?? "?"}`;
      if (vues.has(cle)) continue;
      const reinit = fin ? `, réinitialisation à ${heureReinitialisation(fin, maintenant)}` : "";
      const compte = p.account ? ` (${p.account})` : "";
      alertes.push({
        cle,
        titre: `Quota ${nomCompte(p)} à ${Math.round(w.utilization)}${NB}%`,
        texte: `Fenêtre ${w.label}${NB}: ${textePourcent(w.utilization, "utilise")}${reinit}${compte}.`,
      });
    }
  }
  return alertes;
}

export function alertesVues(stockage: Stockage | null | undefined): string[] {
  try {
    const brut = JSON.parse(stockage?.getItem(CLE_ALERTES_QUOTA) ?? "[]");
    return Array.isArray(brut) ? brut.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function noterAlertesVues(stockage: Stockage | null | undefined, cles: readonly string[]): void {
  const toutes = [...alertesVues(stockage).filter((c) => !cles.includes(c)), ...cles].slice(-ALERTES_GARDEES);
  try {
    stockage?.setItem(CLE_ALERTES_QUOTA, JSON.stringify(toutes));
  } catch {
    /* stockage refusé : l'alerte pourra revenir */
  }
}

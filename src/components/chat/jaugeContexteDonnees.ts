// Jauge du contexte et minuteur du cache de prompt de l'en-tête du chat (JaugeContexte.tsx).
// Données : `sessions.context` du service (dernier appel au modèle de la session) et l'événement
// de flux `contexte` émis après chaque appel. Logique pure, testée par tests/jaugeContexte.test.cjs.

export type DernierAppel = {
  /** Jetons de la requête (entrée + cache lu + cache écrit). */
  jetonsContexte: number;
  jetonsSortie: number;
  cacheLu: number;
  cacheEcrit: number;
  /** Fenêtre du modèle (0 : inconnue du service). */
  fenetre: number;
  seuilCompaction: number | null;
  debutMs: number;
  finMs: number;
  cacheTtlS: number | null;
  cacheExpireMs: number | null;
  modele: string;
};

const NB = "\u00a0";
/** Le cache expiré reste signalé dix minutes, puis disparaît. */
const EXPIRE_VISIBLE_MS = 10 * 60_000;
/** En dessous de dix minutes, le minuteur compte les secondes. */
const SECONDES_SOUS_MS = 10 * 60_000;

const nombre = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Réponse de `sessions.context` (`{appel}`) ou appel seul ; `null` si absent ou illisible. */
export function lireAppel(brut: unknown): DernierAppel | null {
  if (!brut || typeof brut !== "object") return null;
  const objet = brut as Record<string, unknown>;
  const a = ("appel" in objet ? objet.appel : objet) as Record<string, unknown> | null;
  if (!a || typeof a !== "object") return null;
  const jetons = nombre(a.jetonsContexte);
  if (jetons === null) return null;
  return {
    jetonsContexte: jetons,
    jetonsSortie: nombre(a.jetonsSortie) ?? 0,
    cacheLu: nombre(a.cacheLu) ?? 0,
    cacheEcrit: nombre(a.cacheEcrit) ?? 0,
    fenetre: nombre(a.fenetre) ?? 0,
    seuilCompaction: nombre(a.seuilCompaction),
    debutMs: nombre(a.debutMs) ?? 0,
    finMs: nombre(a.finMs) ?? 0,
    cacheTtlS: nombre(a.cacheTtlS),
    cacheExpireMs: nombre(a.cacheExpireMs),
    modele: typeof a.modele === "string" ? a.modele : "",
  };
}

/** 950, « 8,4 k », « 84 k », « 1,3 M ». */
export function formatJetons(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1_000).toFixed(1).replace(".", ",")}${NB}k`;
  if (n < 1_000_000) return `${Math.round(n / 1_000)}${NB}k`;
  return `${(n / 1_000_000).toFixed(1).replace(".", ",")}${NB}M`;
}

const deux = (n: number) => String(n).padStart(2, "0");
const heure = (ms: number) => {
  const d = new Date(ms);
  return `${deux(d.getHours())}:${deux(d.getMinutes())}`;
};

export type EtatJauge = {
  pourcent: number;
  seuilPourcent: number | null;
  ton: "ok" | "warn" | "danger";
  libelle: string;
  detail: string;
};

/** Part de la fenêtre occupée au dernier appel ; `fenetreSecours` : fenêtre du modèle choisi,
 *  quand le service ne la connaît pas (journal relu). `null` : rien à montrer. */
export function etatJauge(appel: DernierAppel | null, fenetreSecours: number): EtatJauge | null {
  if (!appel) return null;
  const fenetre = appel.fenetre > 0 ? appel.fenetre : fenetreSecours;
  if (!(fenetre > 0)) return null;
  const jetons = appel.jetonsContexte;
  const pourcent = Math.min(100, Math.max(0, Math.round((jetons / fenetre) * 100)));
  const seuil = appel.seuilCompaction && appel.seuilCompaction > 0 ? appel.seuilCompaction : null;
  const ton = jetons >= fenetre * 0.95 ? "danger" : (seuil !== null && jetons >= seuil * 0.9) || jetons >= fenetre * 0.8 ? "warn" : "ok";
  const compaction = seuil !== null ? ` · compactage automatique à ${formatJetons(seuil)}` : "";
  return {
    pourcent,
    seuilPourcent: seuil !== null ? Math.min(100, Math.round((seuil / fenetre) * 100)) : null,
    ton,
    libelle: `${pourcent}${NB}%`,
    detail: `Contexte du dernier appel${NB}: ${formatJetons(jetons)} jetons sur ${formatJetons(fenetre)} (${pourcent}${NB}%)${compaction}`,
  };
}

export type EtatCache = { texte: string; detail: string; expire: boolean };

function dureeCache(s: number | null): string {
  if (!s) return "";
  if (s % 3_600 === 0) return ` (${s / 3_600}${NB}h)`;
  if (s % 60 === 0) return ` (${s / 60}${NB}min)`;
  return ` (${s}${NB}s)`;
}

/** Temps restant du cache de prompt (« 4:12 », « 59 min »), puis « expiré » dix minutes. */
export function etatCache(appel: DernierAppel | null, maintenant: number): EtatCache | null {
  if (!appel?.cacheExpireMs) return null;
  const restant = appel.cacheExpireMs - maintenant;
  const fin = heure(appel.cacheExpireMs);
  if (restant > 0) {
    const s = Math.floor(restant / 1_000);
    const texte = restant < SECONDES_SOUS_MS ? `${Math.floor(s / 60)}:${deux(s % 60)}` : `${Math.floor(s / 60)}${NB}min`;
    return {
      texte,
      expire: false,
      detail: `Cache de prompt${dureeCache(appel.cacheTtlS)}${NB}: expire à ${fin}. Un message envoyé avant relit le contexte en cache au lieu de tout renvoyer.`,
    };
  }
  if (-restant > EXPIRE_VISIBLE_MS) return null;
  return { texte: "expiré", expire: true, detail: `Cache de prompt expiré à ${fin}${NB}: le prochain message renverra tout le contexte.` };
}

/** Prochaine relecture de l'horloge : chaque seconde autour de la fin du cache, sinon 30 s. */
export function delaiRafraichissement(appel: DernierAppel | null, maintenant: number): number | null {
  if (!appel?.cacheExpireMs) return null;
  const restant = appel.cacheExpireMs - maintenant;
  if (restant < -EXPIRE_VISIBLE_MS) return null;
  return restant <= SECONDES_SOUS_MS ? 1_000 : 30_000;
}

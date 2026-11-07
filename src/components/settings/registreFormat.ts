// registre de scripts : textes et formats affichés (purs, testés par tests/registreFormat.test.cjs).

export type EtatScript = "propose" | "valide" | "retire" | string;
export type StatutExecution = "ok" | "erreur" | "refuse" | "delai" | string;

const ETATS: Record<string, string> = { propose: "À valider", valide: "Validé", retire: "Retiré" };
const STATUTS: Record<string, string> = { ok: "Réussie", erreur: "Échec", refuse: "Refusée", delai: "Trop longue" };

export const libelleEtat = (etat: EtatScript): string => ETATS[etat] ?? etat;
export const libelleStatut = (statut: StatutExecution): string => STATUTS[statut] ?? statut;

/** Ton de la pastille : ok (vert), attente (accent), erreur (rouge), neutre (gris). */
export function tonEtat(etat: EtatScript): "ok" | "attente" | "neutre" {
  return etat === "valide" ? "ok" : etat === "propose" ? "attente" : "neutre";
}
export function tonStatut(statut: StatutExecution): "ok" | "erreur" | "neutre" {
  return statut === "ok" ? "ok" : statut === "erreur" || statut === "delai" ? "erreur" : "neutre";
}

/** Durée lisible : « 850 ms », « 1,8 s », « 12 s », « 1 min 5 s ». */
export function formatDuree(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1).replace(".", ",")} s`;
  if (s < 60) return `${Math.round(s)} s`;
  const min = Math.floor(s / 60);
  const reste = Math.round(s - min * 60);
  return reste ? `${min} min ${reste} s` : `${min} min`;
}

/** Date courte « 07/11 09:12 » (secondes depuis 1970, comme le portail). */
export function formatDate(secondes: number | null | undefined): string {
  if (secondes == null || !Number.isFinite(secondes) || secondes <= 0) return "—";
  const d = new Date(secondes * 1000);
  const deux = (n: number) => String(n).padStart(2, "0");
  return `${deux(d.getDate())}/${deux(d.getMonth() + 1)} ${deux(d.getHours())}:${deux(d.getMinutes())}`;
}

/** Identifiant accepté par le portail (registre.py) : 2 à 64 caractères, minuscules, chiffres, « . _ - ». */
export const MOTIF_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
export const MOTIF_VERSION = /^\d+\.\d+\.\d+$/;

/** Raison qui empêche de publier (null = publiable). */
export function raisonBlocage(f: { id: string; version: string; code: string }): string | null {
  if (!f.id.trim()) return "Indiquez un identifiant";
  if (!MOTIF_ID.test(f.id.trim())) return "Identifiant : minuscules, chiffres et tirets (2 caractères au moins)";
  if (!MOTIF_VERSION.test(f.version.trim())) return "Version au format 1.0.0";
  if (!f.code.trim()) return "Collez le code du script";
  return null;
}

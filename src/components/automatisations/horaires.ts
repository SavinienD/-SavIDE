// automatisations — aides pures de l'écran (testées dans tests/automatisations.test.cjs) :
// formulaire de l'horaire, libellés, dates et durées en français. L'horaire en clair et les
// prochaines exécutions viennent du service (une seule règle de calcul, la sienne).
import type { Automatisation, Brouillon, Declencheur, Execution, Horaire, StatutExecution } from "./automatisationsApi";

export type GenreHoraire = Horaire["type"];

/** État du formulaire de l'horaire : tous les champs, quel que soit le genre choisi. */
export type FormeHoraire = {
  genre: GenreHoraire;
  heure: string;
  jours: number[];
  heures: number;
  expression: string;
};

export const GENRES: { valeur: GenreHoraire; libelle: string }[] = [
  { valeur: "quotidien", libelle: "Tous les jours" },
  { valeur: "hebdomadaire", libelle: "Certains jours" },
  { valeur: "intervalle", libelle: "Toutes les N heures" },
  { valeur: "cron", libelle: "Expression cron" },
];

/** 1 = lundi … 7 = dimanche. */
export const JOURS: { valeur: number; court: string; nom: string }[] = [
  { valeur: 1, court: "L", nom: "lundi" },
  { valeur: 2, court: "M", nom: "mardi" },
  { valeur: 3, court: "M", nom: "mercredi" },
  { valeur: 4, court: "J", nom: "jeudi" },
  { valeur: 5, court: "V", nom: "vendredi" },
  { valeur: 6, court: "S", nom: "samedi" },
  { valeur: 7, court: "D", nom: "dimanche" },
];

const FORME_DEFAUT: FormeHoraire = { genre: "quotidien", heure: "08:00", jours: [1, 2, 3, 4, 5], heures: 2, expression: "0 8 * * 1-5" };

export function formeDepuisHoraire(h?: Horaire | null): FormeHoraire {
  const f = { ...FORME_DEFAUT, jours: [...FORME_DEFAUT.jours] };
  if (!h) return f;
  switch (h.type) {
    case "quotidien":
      return { ...f, genre: "quotidien", heure: h.heure };
    case "hebdomadaire":
      return { ...f, genre: "hebdomadaire", heure: h.heure, jours: [...h.jours].sort((a, b) => a - b) };
    case "intervalle":
      return { ...f, genre: "intervalle", heures: h.heures };
    case "cron":
      return { ...f, genre: "cron", expression: h.expression };
  }
}

export function horaireDepuisForme(f: FormeHoraire): Horaire {
  switch (f.genre) {
    case "quotidien":
      return { type: "quotidien", heure: f.heure };
    case "hebdomadaire":
      return { type: "hebdomadaire", jours: [...f.jours].sort((a, b) => a - b), heure: f.heure };
    case "intervalle":
      return { type: "intervalle", heures: Math.round(f.heures), minute: 0 };
    case "cron":
      return { type: "cron", expression: f.expression.trim() };
  }
}

/** Coche ou décoche un jour (la liste reste triée). */
export function basculerJour(jours: number[], jour: number): number[] {
  return jours.includes(jour) ? jours.filter((j) => j !== jour) : [...jours, jour].sort((a, b) => a - b);
}

export const STATUTS: Record<StatutExecution, string> = {
  verification: "Vérification",
  en_cours: "En cours",
  reussie: "Réussie",
  echouee: "Échouée",
  sautee: "Sautée",
  manquee: "Manquée",
  arretee: "Arrêtée",
};

export const DECLENCHEURS: Record<Declencheur, string> = {
  horaire: "Prévue",
  rattrapage: "Rattrapage",
  manuel: "Lancée à la main",
};

const deux = (n: number) => String(n).padStart(2, "0");
const JOURS_ABREGES = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];
const MOIS_ABREGES = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

function memeJour(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** « aujourd'hui 08:00 », « demain 08:00 », « hier 18:30 », « lun. 16 nov. 08:00 » (heure locale). */
export function dateCourte(ms: number, maintenantMs: number = Date.now()): string {
  const d = new Date(ms);
  const heure = `${deux(d.getHours())}:${deux(d.getMinutes())}`;
  const auj = new Date(maintenantMs);
  const decale = (jours: number) => new Date(auj.getFullYear(), auj.getMonth(), auj.getDate() + jours);
  if (memeJour(d, auj)) return `aujourd'hui ${heure}`;
  if (memeJour(d, decale(1))) return `demain ${heure}`;
  if (memeJour(d, decale(-1))) return `hier ${heure}`;
  const annee = d.getFullYear() !== auj.getFullYear() ? ` ${d.getFullYear()}` : "";
  return `${JOURS_ABREGES[d.getDay()]} ${d.getDate()} ${MOIS_ABREGES[d.getMonth()]}${annee} ${heure}`;
}

/** « 12 s », « 3 min 05 s », « 1 h 02 min ». */
export function duree(debutMs: number, finMs?: number | null): string {
  if (finMs == null || finMs < debutMs) return "";
  const s = Math.round((finMs - debutMs) / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ${deux(s % 60)} s`;
  return `${Math.floor(min / 60)} h ${deux(min % 60)} min`;
}

/** Dernier élément d'un chemin (« C:\…\client-01 » → « client-01 »). */
export function nomDossier(chemin: string): string {
  const net = chemin.replace(/^\\\\\?\\/, "").replace(/[\\/]+$/, "");
  const parties = net.split(/[\\/]/).filter(Boolean);
  return parties[parties.length - 1] ?? net;
}

/** Ligne « prochaine exécution » d'une carte. */
export function prochaineTexte(a: Pick<Automatisation, "active" | "prochaineMs" | "enCours">, maintenantMs: number = Date.now()): string {
  if (!a.active) return "En pause";
  if (!a.prochaineMs) return "Pas de prochaine exécution";
  return `Prochaine : ${dateCourte(a.prochaineMs, maintenantMs)}`;
}

/** Date affichée d'une exécution : prévue (horaire, rattrapage) ou lancement. */
export function dateExecution(x: Pick<Execution, "prevueMs" | "debutMs">, maintenantMs: number = Date.now()): string {
  return dateCourte(x.prevueMs ?? x.debutMs, maintenantMs);
}

export function brouillonVide(dossier = "", modele = ""): Brouillon {
  return {
    nom: "",
    dossier,
    prompt: "",
    modele,
    horaire: { type: "quotidien", heure: "08:00" },
    memeConversation: false,
    active: true,
    rattrapage: true,
    verification: "",
  };
}

export function brouillonDepuis(a: Automatisation): Brouillon {
  return {
    nom: a.nom,
    dossier: a.dossier,
    prompt: a.prompt,
    modele: `${a.modele.provider}/${a.modele.name}`,
    horaire: a.horaire,
    memeConversation: a.memeConversation,
    active: a.active,
    rattrapage: a.rattrapage,
    verification: a.verification ?? "",
  };
}

/** Champ manquant avant l'envoi (le service vérifie aussi), sinon null. */
export function champManquant(b: Brouillon): string | null {
  if (!b.nom.trim()) return "Donnez un nom à l'automatisation.";
  if (!b.dossier.trim()) return "Choisissez un dossier.";
  if (!b.prompt.trim()) return "Écrivez le prompt à envoyer.";
  if (!b.modele.includes("/")) return "Choisissez un modèle.";
  if (b.horaire.type === "hebdomadaire" && !b.horaire.jours.length) return "Cochez au moins un jour.";
  if (b.horaire.type === "cron" && !b.horaire.expression.trim()) return "Écrivez l'expression cron.";
  return null;
}

/** Les automatisations : en cours d'abord, puis actives par prochaine exécution, puis en pause (par nom). */
export function trier(liste: Automatisation[]): Automatisation[] {
  const rang = (a: Automatisation) => (a.enCours ? 0 : a.active ? 1 : 2);
  return [...liste].sort(
    (a, b) =>
      rang(a) - rang(b) ||
      (a.prochaineMs ?? Infinity) - (b.prochaineMs ?? Infinity) ||
      a.nom.localeCompare(b.nom, "fr"),
  );
}

/** Message d'une erreur du service, sans son préfixe technique. */
export function messageErreur(e: unknown): string {
  const brut = typeof e === "string" ? e : (e as { message?: unknown } | null)?.message ?? String(e ?? "");
  const texte = String(brut)
    .replace(/^Error:\s*/i, "")
    .replace(/^(protocol|runtime|io|journal) error:\s*/i, "")
    .trim();
  return texte || "Erreur inconnue.";
}

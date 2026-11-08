// Revue des changements : notes de relecture d'un dossier, gardées jusqu'à l'envoi ou
// l'effacement (stockage local, une clé par dossier), et message envoyé à l'agent.
// Module pur (testé par tests/revueNotes.test.cjs).

/** « nouveau » : lignes du fichier actuel ; « ancien » : lignes d'avant la
 *  modification ; « apercu » : texte choisi dans l'aperçu Markdown. */
export type CoteNote = "nouveau" | "ancien" | "apercu";

export type NoteRevue = {
  id: string;
  /** Chemin relatif au dossier ouvert. */
  fichier: string;
  debut: number | null;
  fin: number | null;
  cote: CoteNote;
  extrait: string;
  texte: string;
  creeLe: number;
};

export type NouvelleNote = Omit<NoteRevue, "id" | "creeLe">;

export type Stockage = {
  getItem(cle: string): string | null;
  setItem(cle: string, valeur: string): void;
  removeItem(cle: string): void;
};

export const PREFIXE_NOTES = "revue:notes:";
export const EXTRAIT_MAX_LIGNES = 40;
export const EXTRAIT_MAX_CARACTERES = 4000;

export function cleNotes(dossier: string): string {
  return `${PREFIXE_NOTES}${dossier}`;
}

function estNote(v: unknown): v is NoteRevue {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  const numero = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  return (
    typeof n.id === "string" &&
    typeof n.fichier === "string" &&
    typeof n.texte === "string" &&
    typeof n.extrait === "string" &&
    (n.cote === "nouveau" || n.cote === "ancien" || n.cote === "apercu") &&
    numero(n.debut) &&
    numero(n.fin) &&
    typeof n.creeLe === "number"
  );
}

/** Extrait coupé à une taille raisonnable pour le message. */
export function couperExtrait(texte: string): string {
  let lignes = texte.replace(/\r\n?/g, "\n").split("\n");
  let coupe = false;
  if (lignes.length > EXTRAIT_MAX_LIGNES) {
    lignes = lignes.slice(0, EXTRAIT_MAX_LIGNES);
    coupe = true;
  }
  let sortie = lignes.join("\n");
  if (sortie.length > EXTRAIT_MAX_CARACTERES) {
    sortie = sortie.slice(0, EXTRAIT_MAX_CARACTERES);
    coupe = true;
  }
  return coupe ? `${sortie}\n…` : sortie;
}

export class MagasinNotes {
  private cache = new Map<string, NoteRevue[]>();
  private readonly abonnes = new Set<() => void>();
  private ver = 0;
  private suivant = 0;

  constructor(private readonly stockage: Stockage | null) {}

  notes(dossier: string): NoteRevue[] {
    const deja = this.cache.get(dossier);
    if (deja) return deja;
    let lues: NoteRevue[] = [];
    try {
      const brut = this.stockage?.getItem(cleNotes(dossier));
      const valeur: unknown = brut ? JSON.parse(brut) : [];
      if (Array.isArray(valeur)) lues = valeur.filter(estNote);
    } catch {
      lues = [];
    }
    this.cache.set(dossier, lues);
    return lues;
  }

  private ecrire(dossier: string, notes: NoteRevue[]): void {
    this.cache.set(dossier, notes);
    try {
      if (notes.length) this.stockage?.setItem(cleNotes(dossier), JSON.stringify(notes));
      else this.stockage?.removeItem(cleNotes(dossier));
    } catch {
      // stockage plein ou interdit : les notes restent pour cette session
    }
    this.ver += 1;
    for (const f of Array.from(this.abonnes)) {
      try {
        f();
      } catch {
        // un abonné fautif ne bloque pas les autres
      }
    }
  }

  ajouter(dossier: string, note: NouvelleNote, maintenant: number = Date.now()): NoteRevue {
    this.suivant += 1;
    const complete: NoteRevue = {
      ...note,
      texte: note.texte.trim(),
      extrait: couperExtrait(note.extrait),
      id: `n${maintenant.toString(36)}-${this.suivant}`,
      creeLe: maintenant,
    };
    this.ecrire(dossier, [...this.notes(dossier), complete]);
    return complete;
  }

  modifier(dossier: string, id: string, texte: string): void {
    this.ecrire(
      dossier,
      this.notes(dossier).map((n) => (n.id === id ? { ...n, texte: texte.trim() } : n)),
    );
  }

  supprimer(dossier: string, id: string): void {
    this.ecrire(dossier, this.notes(dossier).filter((n) => n.id !== id));
  }

  /** Retire les notes données (après l'envoi), ou toutes. */
  effacer(dossier: string, ids?: readonly string[]): void {
    const garder = ids ? this.notes(dossier).filter((n) => !ids.includes(n.id)) : [];
    this.ecrire(dossier, garder);
  }

  /** Relit le stockage (autre fenêtre). */
  oublier(dossier?: string): void {
    if (dossier) this.cache.delete(dossier);
    else this.cache.clear();
    this.ver += 1;
    for (const f of Array.from(this.abonnes)) f();
  }

  readonly abonner = (f: () => void): (() => void) => {
    this.abonnes.add(f);
    return () => {
      this.abonnes.delete(f);
    };
  };

  readonly version = (): number => this.ver;
}

let magasin: MagasinNotes | null = null;
/** Magasin unique de l'appli (stockage local du navigateur). */
export function magasinNotes(): MagasinNotes {
  if (!magasin) {
    let stockage: Stockage | null = null;
    try {
      stockage = typeof window !== "undefined" ? window.localStorage : null;
    } catch {
      stockage = null;
    }
    magasin = new MagasinNotes(stockage);
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("storage", (e) => {
        if (e.key?.startsWith(PREFIXE_NOTES)) magasin?.oublier(e.key.slice(PREFIXE_NOTES.length));
      });
    }
  }
  return magasin;
}

/** « src/app.ts:12-14 » ; « (avant la modification) » côté ancien. */
export function reperNote(n: NoteRevue): string {
  const lignes = n.debut === null ? "" : n.fin !== null && n.fin !== n.debut ? `:${n.debut}-${n.fin}` : `:${n.debut}`;
  if (n.cote === "apercu") {
    return n.debut === null ? `${n.fichier} (aperçu Markdown)` : `${n.fichier}${lignes} (aperçu Markdown)`;
  }
  return n.cote === "ancien" ? `${n.fichier}${lignes} (avant la modification)` : `${n.fichier}${lignes}`;
}

/** Clôture de bloc de code plus longue que toute suite d'accents graves de l'extrait. */
function cloture(extrait: string): string {
  const plusLongue = Math.max(0, ...Array.from(extrait.matchAll(/`+/g), (m) => m[0].length));
  return "`".repeat(Math.max(3, plusLongue + 1));
}

/** UN message pour l'agent : pour chaque note, fichier:lignes, extrait, note. */
export function messageNotes(notes: readonly NoteRevue[], langage: (fichier: string) => string = () => ""): string {
  const entete =
    notes.length === 1
      ? "Note de relecture sur les changements du dossier. Traite-la, puis dis-moi ce que tu as changé."
      : `${notes.length} notes de relecture sur les changements du dossier. Traite-les dans l'ordre, puis dis-moi ce que tu as changé.`;
  const blocs = notes.map((n, i) => {
    const parties = [`${i + 1}. ${reperNote(n)}`];
    const extrait = n.extrait.replace(/\s+$/, "");
    if (extrait) {
      if (n.cote === "apercu") {
        parties.push(extrait.split("\n").map((l) => `> ${l}`).join("\n"));
      } else {
        const c = cloture(extrait);
        parties.push(`${c}${langage(n.fichier)}\n${extrait}\n${c}`);
      }
    }
    parties.push(`Note : ${n.texte}`);
    return parties.join("\n");
  });
  return [entete, ...blocs].join("\n\n");
}

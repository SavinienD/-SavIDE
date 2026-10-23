// axe:file-attente — file d'attente des messages, partagée par tous les volets.
//
// Avant (0.1.54) la file vivait dans un useState de CHAQUE ChatPane : changer
// de colonne, cliquer dans une autre colonne (le focus change de colonne, donc
// la clé « chat-focus » change de parent), détacher, ouvrir le journal d'un
// sous-agent… recréaient le volet et la file disparaissait. Elle vit
// maintenant ici, au niveau du module, et chaque conversation garde sa file
// dans le stockage local (relue au démarrage de l'appli). Stockage plein ou
// interdit : la file reste en mémoire, rien ne plante.
//
// Un seul envoi automatique par conversation : le marqueur « envoi en cours »
// est ici (pas un useRef par volet) et `prendreEnvoi` retire l'élément de la
// file dans le même geste. Deux volets qui montrent la même conversation ne
// peuvent donc jamais envoyer deux fois.
//
// Conversation « occupée » (`occuper`/`liberer`) : la compaction lancée par
// l'interface finit par un « turn_finished » (src-tauri/src/turns.rs) alors
// que Workspace envoie encore la relance « Continue from the compacted
// context » juste après ; « Arrière-plan » arrête le tour puis le clone. Tant
// que l'opération n'est pas finie, rien ne part de la file.
//
// Note d'arrière-plan (`poserNote`/`prendreNote`) : la ligne qui dit que le
// travail continue ailleurs part devant le prochain message de la conversation.
//
// Module pur (aucun import) : testé par tests/fileAttente.test.cjs.

export type PieceJointeFile = { path: string; name?: string };

export type ElementFile = {
  id: string;
  text: string;
  attachments: PieceJointeFile[];
};

/** Le strict nécessaire de `window.localStorage`. */
export type Stockage = {
  getItem(cle: string): string | null;
  setItem(cle: string, valeur: string): void;
  removeItem(cle: string): void;
  key(index: number): string | null;
  readonly length: number;
};

export const PREFIXE_CLE_FILE = "axe:file-attente:";
export const PREFIXE_CLE_NOTE = "axe:file-attente-note:";

export function cleFile(conversationId: string): string {
  return `${PREFIXE_CLE_FILE}${conversationId}`;
}

export function cleNote(conversationId: string): string {
  return `${PREFIXE_CLE_NOTE}${conversationId}`;
}

function estPieceJointe(valeur: unknown): boolean {
  if (!valeur || typeof valeur !== "object") return false;
  const p = valeur as Record<string, unknown>;
  return typeof p.path === "string" && (p.name === undefined || typeof p.name === "string");
}

export function estElementFile(valeur: unknown): boolean {
  if (!valeur || typeof valeur !== "object") return false;
  const e = valeur as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    e.id.length > 0 &&
    typeof e.text === "string" &&
    Array.isArray(e.attachments) &&
    e.attachments.every(estPieceJointe)
  );
}

/** Relit une file écrite par `serialiserFile` ; tout ce qui est abîmé est ignoré. */
export function relireFile<T extends ElementFile>(brut: string | null | undefined): T[] {
  if (!brut) return [];
  try {
    const valeur: unknown = JSON.parse(brut);
    if (!Array.isArray(valeur)) return [];
    const vus = new Set<string>();
    const file: T[] = [];
    for (const element of valeur) {
      if (!estElementFile(element)) continue;
      const id = (element as T).id;
      if (vus.has(id)) continue;
      vus.add(id);
      file.push(element as T);
    }
    return file;
  } catch {
    return [];
  }
}

export function serialiserFile<T extends ElementFile>(file: readonly T[]): string {
  return JSON.stringify(file);
}

export type EtatFiles<T extends ElementFile> = {
  /** File de chaque conversation (jamais de liste vide). */
  files: Map<string, T[]>;
  /** Conversation -> id de l'élément en cours d'envoi automatique. */
  enVol: ReadonlyMap<string, string>;
  /** Conversation -> opérations en cours (compaction + relance, arrière-plan). */
  occupations: ReadonlyMap<string, number>;
  /** Conversation -> ligne à mettre devant son prochain message. */
  notes: ReadonlyMap<string, string>;
  /** Éléments bloqués (2e échec d'envoi : flèche manuelle seulement). */
  bloques: ReadonlySet<string>;
  /** Conversations dont la file n'a pas pu être écrite (stockage plein). */
  nonSauvees: ReadonlySet<string>;
};

type Decision = {
  occupe: boolean;
  sousAgent: boolean;
  edition: boolean;
};

export class MagasinFiles<T extends ElementFile> {
  private etat: EtatFiles<T>;
  private readonly ecouteurs = new Set<() => void>();
  private readonly essais = new Map<string, number>();

  constructor(private readonly stockage: Stockage | null) {
    const files = new Map<string, T[]>();
    const notes = new Map<string, string>();
    if (stockage) {
      try {
        const cles: string[] = [];
        for (let i = 0; i < stockage.length; i += 1) {
          const cle = stockage.key(i);
          if (cle && (cle.startsWith(PREFIXE_CLE_FILE) || cle.startsWith(PREFIXE_CLE_NOTE))) {
            cles.push(cle);
          }
        }
        for (const cle of cles) {
          if (cle.startsWith(PREFIXE_CLE_NOTE)) {
            const id = cle.slice(PREFIXE_CLE_NOTE.length);
            const texte = stockage.getItem(cle);
            if (id && texte) notes.set(id, texte);
            continue;
          }
          const file = relireFile<T>(stockage.getItem(cle));
          const id = cle.slice(PREFIXE_CLE_FILE.length);
          if (id && file.length > 0) files.set(id, file);
        }
      } catch {
        // Stockage illisible : on part d'une file vide, en mémoire.
      }
    }
    this.etat = {
      files,
      enVol: new Map(),
      occupations: new Map(),
      notes,
      bloques: new Set(),
      nonSauvees: new Set(),
    };
  }

  /** Pour useSyncExternalStore. */
  readonly abonner = (ecouteur: () => void): (() => void) => {
    this.ecouteurs.add(ecouteur);
    return () => {
      this.ecouteurs.delete(ecouteur);
    };
  };

  /** Instantané immuable (même objet tant que rien ne change). */
  readonly instantane = (): EtatFiles<T> => this.etat;

  file(conversationId: string): T[] {
    return this.etat.files.get(conversationId) ?? [];
  }

  private publier(suivant: Partial<EtatFiles<T>>): void {
    this.etat = { ...this.etat, ...suivant };
    for (const ecouteur of Array.from(this.ecouteurs)) {
      try {
        ecouteur();
      } catch {
        // Un écouteur fautif ne bloque pas les autres.
      }
    }
  }

  /**
   * Écrit la file d'une conversation ; false si le stockage refuse (plein).
   * Dans ce cas l'ancienne copie est effacée : relue au redémarrage, une copie
   * périmée renverrait des messages déjà partis (jamais de double envoi).
   */
  private sauver(conversationId: string, file: readonly T[] | undefined): boolean {
    if (!this.stockage) return true;
    const cle = cleFile(conversationId);
    try {
      if (!file || file.length === 0) this.stockage.removeItem(cle);
      else this.stockage.setItem(cle, serialiserFile(file));
      return true;
    } catch {
      try {
        this.stockage.removeItem(cle);
      } catch {
        // Rien de plus à faire : la file reste en mémoire.
      }
      return false;
    }
  }

  /**
   * Même contrat qu'un setState fonctionnel sur Map<conversation, file> :
   * `maj` reçoit la Map actuelle et rend la suivante (nouvelle Map).
   */
  modifierFiles(maj: (actuel: Map<string, T[]>) => Map<string, T[]>): void {
    const avant = this.etat.files;
    const apres = maj(avant);
    if (apres === avant) return;
    const propre = new Map<string, T[]>();
    for (const [id, file] of apres) if (file.length > 0) propre.set(id, file);
    let nonSauvees = this.etat.nonSauvees;
    const ids = new Set<string>([...avant.keys(), ...propre.keys()]);
    for (const id of ids) {
      if (avant.get(id) === propre.get(id)) continue;
      const ok = this.sauver(id, propre.get(id));
      if (ok === nonSauvees.has(id)) {
        const copie = new Set(nonSauvees);
        if (ok) copie.delete(id);
        else copie.add(id);
        nonSauvees = copie;
      }
    }
    this.publier({ files: propre, nonSauvees });
  }

  /** La file d'une conversation via une fonction (insérer, déplacer…). */
  modifierFile(conversationId: string, maj: (file: T[]) => T[]): void {
    this.modifierFiles((actuel) => {
      const avant = actuel.get(conversationId) ?? [];
      const apres = maj(avant);
      if (apres === avant) return actuel;
      const suivant = new Map(actuel);
      if (apres.length === 0) suivant.delete(conversationId);
      else suivant.set(conversationId, apres);
      return suivant;
    });
  }

  envoiEnCours(conversationId: string): boolean {
    return this.etat.enVol.has(conversationId);
  }

  /**
   * Réserve l'envoi de `elementId` : false si un envoi de cette conversation
   * est déjà en cours (ou si l'élément n'est plus dans la file). Sinon
   * l'élément quitte la file dans le même geste : il ne peut partir qu'une fois.
   */
  prendreEnvoi(conversationId: string, elementId: string): boolean {
    if (this.etat.enVol.has(conversationId)) return false;
    const file = this.file(conversationId);
    if (!file.some((element) => element.id === elementId)) return false;
    const enVol = new Map(this.etat.enVol);
    enVol.set(conversationId, elementId);
    this.etat = { ...this.etat, enVol };
    this.modifierFile(conversationId, (actuelle) =>
      actuelle.filter((element) => element.id !== elementId),
    );
    return true;
  }

  /** Fin d'un envoi (réussi ou non) : seul celui qui l'a pris le libère. */
  libererEnvoi(conversationId: string, elementId: string): void {
    if (this.etat.enVol.get(conversationId) !== elementId) return;
    const enVol = new Map(this.etat.enVol);
    enVol.delete(conversationId);
    this.publier({ enVol });
  }

  /** Une opération (compaction + relance, arrière-plan) tient la conversation. */
  occupee(conversationId: string): boolean {
    return (this.etat.occupations.get(conversationId) ?? 0) > 0;
  }

  occuper(conversationId: string): void {
    const occupations = new Map(this.etat.occupations);
    occupations.set(conversationId, (occupations.get(conversationId) ?? 0) + 1);
    this.publier({ occupations });
  }

  liberer(conversationId: string): void {
    const n = this.etat.occupations.get(conversationId) ?? 0;
    if (n <= 0) return;
    const occupations = new Map(this.etat.occupations);
    if (n === 1) occupations.delete(conversationId);
    else occupations.set(conversationId, n - 1);
    this.publier({ occupations });
  }

  note(conversationId: string): string | null {
    return this.etat.notes.get(conversationId) ?? null;
  }

  /** La ligne partira devant le prochain message de la conversation. */
  poserNote(conversationId: string, texte: string): void {
    const notes = new Map(this.etat.notes);
    notes.set(conversationId, texte);
    try {
      this.stockage?.setItem(cleNote(conversationId), texte);
    } catch {
      // Stockage plein : la note vit en mémoire.
    }
    this.publier({ notes });
  }

  /** Prend (et retire) la note de la conversation ; null s'il n'y en a pas. */
  prendreNote(conversationId: string): string | null {
    const texte = this.etat.notes.get(conversationId);
    if (texte === undefined) return null;
    const notes = new Map(this.etat.notes);
    notes.delete(conversationId);
    try {
      this.stockage?.removeItem(cleNote(conversationId));
    } catch {
      // Rien à faire : la note est déjà sortie de la mémoire.
    }
    this.publier({ notes });
    return texte;
  }

  estBloque(elementId: string): boolean {
    return this.etat.bloques.has(elementId);
  }

  bloquer(elementId: string): void {
    if (this.etat.bloques.has(elementId)) return;
    const bloques = new Set(this.etat.bloques);
    bloques.add(elementId);
    this.publier({ bloques });
  }

  debloquer(elementId: string): void {
    if (!this.etat.bloques.has(elementId)) return;
    const bloques = new Set(this.etat.bloques);
    bloques.delete(elementId);
    this.publier({ bloques });
  }

  /** Compte un échec d'envoi de l'élément ; renvoie le nombre d'échecs. */
  noterEchec(elementId: string): number {
    const n = (this.essais.get(elementId) ?? 0) + 1;
    this.essais.set(elementId, n);
    return n;
  }

  /** Le message à envoyer maintenant, ou null (voir `prochainEnvoi`). */
  prochain(conversationId: string, decision: Decision): T | null {
    return prochainEnvoi({
      file: this.file(conversationId),
      ...decision,
      enVol: this.envoiEnCours(conversationId),
      occupee: this.occupee(conversationId),
      bloque: (id) => this.estBloque(id),
    });
  }
}

/**
 * Envoi automatique : le premier de la file, seulement quand la conversation
 * est libre (pas de tour, pas d'opération en cours — compaction et relance,
 * arrière-plan —, pas d'envoi déjà parti, pas de sous-agent affiché, pas
 * d'élément en édition).
 * Un premier élément bloqué (2e échec) attend la flèche manuelle.
 */
export function prochainEnvoi<T extends ElementFile>(args: {
  file: readonly T[];
  occupe: boolean;
  sousAgent: boolean;
  edition: boolean;
  enVol: boolean;
  occupee: boolean;
  bloque: (id: string) => boolean;
}): T | null {
  if (args.occupe || args.sousAgent || args.edition || args.enVol || args.occupee) {
    return null;
  }
  const premier = args.file[0];
  if (!premier || args.bloque(premier.id)) return null;
  return premier;
}

function stockageDuNavigateur(): Stockage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

let partage: MagasinFiles<ElementFile> | null = null;

/** Le magasin unique de l'appli (créé au premier appel). */
export function filesPartagees<T extends ElementFile>(): MagasinFiles<T> {
  partage ??= new MagasinFiles<ElementFile>(stockageDuNavigateur());
  return partage as unknown as MagasinFiles<T>;
}

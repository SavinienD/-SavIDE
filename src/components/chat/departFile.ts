// file-envoi-affiche — départ d'un message de la file d'attente, affiché tout de suite.
//
// Depuis que la file vit dans le service, « envoyer maintenant » (flèche de la file, double Entrée)
// met le message en tête de la file du service, arrête le tour en cours, puis
// relance la file : c'est le service qui envoie le message, quelques secondes
// plus tard (le temps que le tour s'arrête vraiment). Pendant ce délai, rien ne
// se voyait : pas de bulle, bouton « Envoyer », message toujours dans la file.
//
// Ce suivi tient, par conversation :
// - le message « en départ » (annoncé au clic) : retiré de la file affichée,
//   montré comme une bulle « en cours d'envoi », bouton « Stop » ;
// - la dernière file reçue du service, pour reconnaître le message qui part.
//
// Le service annonce le message qu'il envoie (`sending` dans l'événement
// « queue » qui le retire de la file) et celui qu'il remet en file après un
// échec (`failed`, `error`). Avec un service plus ancien (sans `sending`), le
// message en départ qui quitte la file sans avoir été retiré par
// l'utilisateur est considéré comme parti.
//
// Module pur (aucun import) : testé par tests/departFile.test.cjs.

export type ElementDepart = {
  id: string;
  text: string;
  attachments: ReadonlyArray<{ path: string; name?: string }>;
};

/** Ce que le service dit de la file avec sa nouvelle copie. */
export type SignalFile = {
  /** Élément retiré de la file parce qu'il part (envoyé maintenant). */
  sending?: string | null;
  /** Élément remis en tête de file : l'envoi a échoué. */
  failed?: string | null;
  error?: string | null;
};

export type Mouvement<T> =
  | { type: "parti"; item: T }
  | { type: "echec"; item: T; erreur: string };

type Depart<T> = { item: T; depuisMs: number };

/** Délai sans nouvelles du service après lequel le message en départ revient dans la file. */
export const DEPART_SANS_NOUVELLES_MS = 30_000;

export const ERREUR_DEPART =
  "Le message n'est pas parti : il est revenu dans la file d'attente.";

export class SuiviDeparts<T extends ElementDepart> {
  private readonly departs = new Map<string, Depart<T>>();
  private readonly derniers = new Map<string, T[]>();
  /** Éléments partis (bulle affichée) : le service peut encore les remettre en file. */
  private readonly partis = new Map<string, string>();
  /** Éléments retirés par l'utilisateur : leur disparition n'est pas un départ. */
  private readonly retires = new Set<string>();
  private readonly ecouteurs = new Set<() => void>();
  private version = 0;

  /** Pour useSyncExternalStore. */
  readonly abonner = (ecouteur: () => void): (() => void) => {
    this.ecouteurs.add(ecouteur);
    return () => {
      this.ecouteurs.delete(ecouteur);
    };
  };

  readonly instantane = (): number => this.version;

  private publier(): void {
    this.version += 1;
    for (const ecouteur of Array.from(this.ecouteurs)) {
      try {
        ecouteur();
      } catch {
        // Un écouteur fautif ne bloque pas les autres.
      }
    }
  }

  /** Le message en départ de la conversation, ou null. */
  enDepart(conversationId: string): T | null {
    return this.departs.get(conversationId)?.item ?? null;
  }

  depuis(conversationId: string): number | null {
    return this.departs.get(conversationId)?.depuisMs ?? null;
  }

  /** « Envoyer maintenant » : le message quitte la file affichée et devient une bulle en cours d'envoi. */
  annoncer(conversationId: string, item: T, maintenant: number = Date.now()): void {
    this.retires.delete(item.id);
    this.departs.set(conversationId, { item, depuisMs: maintenant });
    this.publier();
  }

  /** Échec côté interface (Stop, reprise de la file…) : le message redevient un message en file. */
  annuler(conversationId: string): T | null {
    const depart = this.departs.get(conversationId);
    if (!depart) return null;
    this.departs.delete(conversationId);
    this.publier();
    return depart.item;
  }

  /** L'utilisateur retire l'élément de la file (ou le modifie) : pas un départ. */
  retirer(itemId: string): void {
    this.retires.add(itemId);
    if (this.retires.size > 500) {
      const premier = this.retires.values().next().value;
      if (premier !== undefined) this.retires.delete(premier);
    }
  }

  /** La file à afficher : sans le message en départ. */
  visibles<U extends { id: string }>(conversationId: string, items: readonly U[]): U[] {
    const id = this.departs.get(conversationId)?.item.id;
    return id === undefined ? items.slice() : items.filter((item) => item.id !== id);
  }

  /** Dernière file complète reçue du service (avant filtrage). */
  derniere(conversationId: string): T[] {
    return this.derniers.get(conversationId) ?? [];
  }

  /**
   * Nouvelle copie de la file du service. Rend les mouvements à montrer :
   * « parti » (bulle dans la conversation, tour en préparation) ou « echec »
   * (la bulle redevient un message en file, avec l'erreur).
   */
  recevoir(conversationId: string, items: readonly T[], signal: SignalFile = {}): Mouvement<T>[] {
    const avant = this.derniers.get(conversationId) ?? [];
    const copie = items.slice();
    if (copie.length > 0) this.derniers.set(conversationId, copie);
    else this.derniers.delete(conversationId);
    const presents = new Set(copie.map((item) => item.id));
    const depart = this.departs.get(conversationId);
    const sortie: Mouvement<T>[] = [];
    let change = false;

    if (signal.failed && presents.has(signal.failed)) {
      const item = copie.find((element) => element.id === signal.failed)!;
      const erreur = signal.error ? `${ERREUR_DEPART} (${signal.error})` : ERREUR_DEPART;
      if (this.partis.get(item.id) === conversationId) {
        this.partis.delete(item.id);
        sortie.push({ type: "echec", item, erreur });
      } else if (depart?.item.id === item.id) {
        this.departs.delete(conversationId);
        change = true;
        sortie.push({ type: "echec", item, erreur });
      }
    }

    let partiId: string | null = signal.sending ?? null;
    if (
      !partiId &&
      depart &&
      this.departs.get(conversationId) === depart &&
      !presents.has(depart.item.id) &&
      avant.some((item) => item.id === depart.item.id) &&
      !this.retires.has(depart.item.id)
    ) {
      // Service sans « sending » : le message en départ a quitté la file.
      partiId = depart.item.id;
    }
    if (partiId && !presents.has(partiId)) {
      const item =
        (depart?.item.id === partiId ? depart.item : null) ??
        avant.find((element) => element.id === partiId) ??
        null;
      if (depart?.item.id === partiId && this.departs.get(conversationId) === depart) {
        this.departs.delete(conversationId);
        change = true;
      }
      if (item) {
        this.partis.set(item.id, conversationId);
        if (this.partis.size > 200) {
          const premier = this.partis.keys().next().value;
          if (premier !== undefined) this.partis.delete(premier);
        }
        sortie.push({ type: "parti", item });
      }
    }
    if (change || sortie.length > 0) this.publier();
    return sortie;
  }

  /**
   * Message en départ resté sans nouvelles (tour fini, rien envoyé) : il
   * revient dans la file. Rend l'élément rendu, ou null.
   */
  expirer(conversationId: string, maintenant: number, delaiMs = DEPART_SANS_NOUVELLES_MS): T | null {
    const depart = this.departs.get(conversationId);
    if (!depart || maintenant - depart.depuisMs < delaiMs) return null;
    return this.annuler(conversationId);
  }
}

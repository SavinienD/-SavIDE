// Sauvegarde automatique : QUAND enregistrer un onglet modifié.
// « Après 1 s » : 1 s après la dernière frappe ; « En quittant l'onglet » : autre onglet,
// clic ailleurs (l'éditeur perd le focus), fenêtre quittée. Le mode « après 1 s » enregistre
// aussi en quittant l'onglet. La fermeture d'un onglet modifié est traitée à part
// (fermeture.ts), car l'onglet disparaît. Une seule écriture à la fois par fichier :
// une demande arrivée pendant l'écriture est rejouée juste après.

import { DELAI_SAUVEGARDE_MS, type SauvegardeAuto } from "./reglagesEditeur";

export type Minuterie = {
  poser: (f: () => void, ms: number) => unknown;
  annuler: (id: unknown) => void;
};

const minuterieFenetre: Minuterie = {
  poser: (f, ms) => setTimeout(f, ms),
  annuler: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

export class PlanificateurSauvegarde {
  private readonly minuteries = new Map<string, unknown>();
  private readonly enCours = new Map<string, Promise<void>>();
  private readonly aRefaire = new Set<string>();

  /**
   * @param mode réglage courant (relu à chaque demande)
   * @param sauver enregistre l'onglet `chemin` s'il est encore modifié
   */
  constructor(
    private readonly mode: () => SauvegardeAuto,
    private readonly sauver: (chemin: string) => Promise<void> | void,
    private readonly minuterie: Minuterie = minuterieFenetre,
  ) {}

  /** Le texte de l'onglet vient de changer (frappe). */
  modifie(chemin: string): void {
    if (this.mode() !== "delai") return;
    this.annulerMinuterie(chemin);
    const id = this.minuterie.poser(() => {
      this.minuteries.delete(chemin);
      void this.maintenant(chemin);
    }, DELAI_SAUVEGARDE_MS);
    this.minuteries.set(chemin, id);
  }

  /** On quitte l'onglet : enregistré tout de suite (sauf mode désactivé). */
  quitte(chemin: string): void {
    if (this.mode() === "desactivee") return;
    this.annulerMinuterie(chemin);
    void this.maintenant(chemin);
  }

  /** Enregistre maintenant (une écriture à la fois par fichier). */
  async maintenant(chemin: string): Promise<void> {
    const cours = this.enCours.get(chemin);
    if (cours) {
      this.aRefaire.add(chemin);
      return cours;
    }
    const tache = (async () => {
      try {
        await this.sauver(chemin);
      } catch {
        // l'appelant affiche l'erreur ; l'onglet reste marqué modifié
      }
    })();
    this.enCours.set(chemin, tache);
    try {
      await tache;
    } finally {
      this.enCours.delete(chemin);
    }
    if (this.aRefaire.delete(chemin)) await this.maintenant(chemin);
  }

  /** Enregistrements en attente lancés tout de suite (colonne fermée, dossier quitté). */
  vider(): void {
    const chemins = [...this.minuteries.keys()];
    for (const chemin of chemins) this.annulerMinuterie(chemin);
    for (const chemin of chemins) void this.maintenant(chemin);
  }

  /** Nombre d'enregistrements différés (tests). */
  enAttente(): number {
    return this.minuteries.size;
  }

  private annulerMinuterie(chemin: string): void {
    const id = this.minuteries.get(chemin);
    if (id === undefined) return;
    this.minuterie.annuler(id);
    this.minuteries.delete(chemin);
  }
}

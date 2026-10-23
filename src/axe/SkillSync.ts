// axe:e4 — synchronisation des skills partagées (/srv/axe/commun/skills).
//
// Toutes les 5 minutes : on lit l'empreinte des skills du répertoire partagé
// (via un lecteur injecté : IPC Tauri / API de l'espace), on la compare à celle
// gardée dans localStorage et, si elle diffère, on la mémorise et on prévient
// l'UI (badge « Skills synchronisées »).

export const DOSSIER_SKILLS = "/srv/axe/commun/skills";
export const CLE_SKILLS = "axe:skills:empreintes";
export const INTERVALLE_SYNC_MS = 5 * 60 * 1000;

/** nom de skill -> empreinte (hash ou date de modification du SKILL.md). */
export type Empreintes = Record<string, string>;
export type Lecteur = (dossier: string) => Promise<Empreintes>;
export type Difference = { ajoutees: string[]; modifiees: string[]; retirees: string[] };

type Stockage = Pick<Storage, "getItem" | "setItem">;

export function comparer(avant: Empreintes, apres: Empreintes): Difference {
  const d: Difference = { ajoutees: [], modifiees: [], retirees: [] };
  for (const [nom, e] of Object.entries(apres)) {
    if (!(nom in avant)) d.ajoutees.push(nom);
    else if (avant[nom] !== e) d.modifiees.push(nom);
  }
  for (const nom of Object.keys(avant)) if (!(nom in apres)) d.retirees.push(nom);
  return d;
}

export const vide = (d: Difference) =>
  d.ajoutees.length + d.modifiees.length + d.retirees.length === 0;

export class SkillSync {
  private minuterie: ReturnType<typeof setInterval> | null = null;
  private abonnes = new Set<(d: Difference) => void>();

  constructor(
    private lire: Lecteur,
    private stockage: Stockage | null = typeof localStorage !== "undefined" ? localStorage : null,
    private dossier = DOSSIER_SKILLS,
    private intervalle = INTERVALLE_SYNC_MS,
  ) {}

  /** Abonnement de l'UI : appelé seulement quand quelque chose a changé. */
  surMiseAJour(f: (d: Difference) => void): () => void {
    this.abonnes.add(f);
    return () => this.abonnes.delete(f);
  }

  private connues(): Empreintes {
    try {
      const v = JSON.parse(this.stockage?.getItem(CLE_SKILLS) ?? "{}");
      return v && typeof v === "object" ? (v as Empreintes) : {};
    } catch {
      return {};
    }
  }

  async verifier(): Promise<Difference | null> {
    let actuelles: Empreintes;
    try {
      actuelles = await this.lire(this.dossier);
    } catch {
      return null; // dossier injoignable : on retentera au prochain tour
    }
    const d = comparer(this.connues(), actuelles);
    if (vide(d)) return d;
    try {
      this.stockage?.setItem(CLE_SKILLS, JSON.stringify(actuelles));
    } catch {
      /* stockage plein */
    }
    for (const f of this.abonnes) f(d);
    return d;
  }

  demarrer(): void {
    if (this.minuterie) return;
    void this.verifier();
    this.minuterie = setInterval(() => void this.verifier(), this.intervalle);
  }

  arreter(): void {
    if (this.minuterie) clearInterval(this.minuterie);
    this.minuterie = null;
  }
}

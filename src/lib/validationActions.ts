// mode « Demander avant d'agir » : demandes en attente reçues du
// service (événements `approbation` / `approbation_fin`), conversations affichées,
// règle des notifications « attente » (contrat ide-notification). Module pur
// (sans Tauri), testé par tests/interopValidation.test.cjs.

export type ModeValidation = "autonome" | "demander";
export type DecisionValidation = "autoriser" | "refuser" | "toujours";

export type Demande = {
  id: string;
  sessionId: string;
  racineId: string;
  parentId?: string | null;
  nomSession: string;
  dossier: string;
  outil: string;
  callId: string;
  code: string;
  creeLe: number;
};

export type ModeEffectif = {
  mode: ModeValidation;
  explicite?: ModeValidation | null;
  heriteDe?: string | null;
  defaut: ModeValidation;
};

export type EntreeDemande = { demande: Demande; connexion: string | null };

type Evenement = { event?: string; sessionId?: string; connectionId?: string; data?: { status?: string; event?: { type?: string; id?: string; demande?: Demande } } };

const demandes = new Map<string, EntreeDemande>();
const abonnes = new Set<() => void>();
let version = 0;

function changer(): void {
  version += 1;
  for (const f of abonnes) f();
}

export function abonner(f: () => void): () => void {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

export const versionDemandes = (): number => version;

/** Applique un événement du service ; rend la demande si elle est nouvelle. */
export function appliquerEvenement(p: Evenement | null | undefined): Demande | null {
  if (!p) return null;
  const connexion = p.connectionId ?? null;
  if (p.event === "stream") {
    const ev = p.data?.event;
    if (ev?.type === "approbation" && ev.demande?.id) {
      if (demandes.has(ev.demande.id)) return null;
      demandes.set(ev.demande.id, { demande: ev.demande, connexion });
      changer();
      return ev.demande;
    }
    if (ev?.type === "approbation_fin" && ev.id && demandes.delete(ev.id)) changer();
    return null;
  }
  // Session qui ne travaille plus (tour arrêté, service relancé) : ses demandes sont caduques.
  if (p.event === "status" && p.sessionId && p.data?.status && p.data.status !== "running") {
    let retire = false;
    for (const [id, e] of demandes) {
      if (e.demande.sessionId === p.sessionId) retire = demandes.delete(id) || retire;
    }
    if (retire) changer();
  }
  return null;
}

/** Remplace les demandes d'une connexion par la liste du service ; rend les nouvelles. */
export function remplacer(liste: Demande[], connexion: string | null): Demande[] {
  const nouvelles: Demande[] = [];
  const ids = new Set(liste.map((d) => d.id));
  let change = false;
  for (const [id, e] of demandes) {
    if (e.connexion === connexion && !ids.has(id)) change = demandes.delete(id) || change;
  }
  for (const d of liste) {
    if (!demandes.has(d.id)) {
      demandes.set(d.id, { demande: d, connexion });
      nouvelles.push(d);
      change = true;
    }
  }
  if (change) changer();
  return nouvelles;
}

/** Retire une demande (réponse envoyée). */
export function retirer(id: string): void {
  if (demandes.delete(id)) changer();
}

/** Demandes à montrer dans une conversation : les siennes et celles de ses sous-agents. */
export function pourConversation(id: string): EntreeDemande[] {
  return [...demandes.values()]
    .filter((e) => e.demande.sessionId === id || e.demande.racineId === id)
    .sort((a, b) => a.demande.creeLe - b.demande.creeLe);
}

export const toutesLesDemandes = (): EntreeDemande[] => [...demandes.values()];

// ---- conversations affichées (pour ne pas notifier ce qu'on a sous les yeux) ----

const vues = new Map<string, number>();

export function monterVue(id: string): () => void {
  vues.set(id, (vues.get(id) ?? 0) + 1);
  return () => {
    const n = (vues.get(id) ?? 1) - 1;
    if (n <= 0) vues.delete(id);
    else vues.set(id, n);
  };
}

export const vuesMontees = (): ReadonlySet<string> => new Set(vues.keys());

/** Notifier ? Toujours pour un sous-agent ; sinon si la conversation n'est pas sous les yeux. */
export function doitNotifier(d: Demande, visibles: ReadonlySet<string>, fenetreVisible: boolean): boolean {
  if (d.parentId) return true;
  return !fenetreVisible || !visibles.has(d.racineId);
}

/** Première ligne utile du code (aperçu d'une ligne). */
export function premiereLigne(code: string, max = 80): string {
  const ligne = code.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#")) ?? code.trim();
  return ligne.length > max ? `${ligne.slice(0, max - 1)}…` : ligne;
}

/** Détail de l'événement `ide-notification` (genre « attente »). */
export function notification(d: Demande): { genre: "attente"; titre: string; texte: string; dossier: string; sessionId: string } {
  return {
    genre: "attente",
    titre: d.parentId ? "Un sous-agent attend votre accord" : "Action à valider",
    texte: `${d.nomSession} : ${premiereLigne(d.code)}`,
    dossier: d.dossier,
    sessionId: d.racineId,
  };
}

/** Paramètres de `approbation.repondre`. */
export function parametresReponse(id: string, decision: DecisionValidation, motif?: string): { id: string; decision: DecisionValidation; motif?: string } {
  const m = (motif ?? "").trim();
  return decision === "refuser" && m ? { id, decision, motif: m } : { id, decision };
}

/** Libellé du réglage d'une conversation. */
export function libelleMode(m: ModeEffectif | null): string {
  if (!m) return "Demander avant d'agir";
  const base = m.mode === "demander" ? "Demander avant d'agir : oui" : "Demander avant d'agir : non";
  if (m.explicite) return base;
  return m.heriteDe ? `${base} (comme la conversation parente)` : `${base} (réglage par défaut)`;
}

/** Prochain réglage quand on clique le bouton de la conversation. */
export const basculer = (m: ModeEffectif | null): ModeValidation => (m?.mode === "demander" ? "autonome" : "demander");

/** Pour les tests : vide le magasin. */
export function viderPourTests(): void {
  demandes.clear();
  vues.clear();
  version = 0;
}

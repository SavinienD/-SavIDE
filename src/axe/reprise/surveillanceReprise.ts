// Surveillance des limites d'abonnement : une erreur de tour due à une limite (service local,
// événements axe://daemon), sur un compte Claude ou ChatGPT dont le quota est lu, planifie la
// reprise de la session à la réinitialisation de la fenêtre épuisée ; à l'heure dite, le message
// de reprise part (`sessions.send`), sauf si la session a déjà repris. Conversations et
// sous-agents (sessions du service) de la même façon.
// Une seule fenêtre surveille et relance (la principale) ; la file est gardée dans le stockage
// local : les autres fenêtres l'affichent et l'annulent, et une reprise prévue survit à un
// redémarrage de l'appli (relancée au démarrage si son heure est passée).
// Logique : repriseAuto.ts ; bandeau : BandeauReprise.tsx.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { QuotaReport } from "../quotas";
import {
  CLE_FILE,
  MAX_ESSAIS,
  TEXTE_REPRISE,
  annuler,
  echues,
  ecrireFile,
  essaiSuivant,
  estAbonnement,
  estLimite,
  heureCourte,
  heureReprise,
  lireFile,
  lirePrecedentes,
  noterPrecedente,
  planifier,
  type Reprise,
} from "./repriseAuto";

type EvenementDemon = { event?: string; sessionId?: string; connectionId?: string; data?: Record<string, any> };
type MetaSession = { name?: string; parentId?: string | null; status?: string; model?: { provider?: string } };

/** Le minuteur se réveille au moins chaque minute (veille du poste, horloge changée). */
const VERIFICATION_MS = 60_000;
/** Service injoignable à l'heure dite : nouvel essai une minute plus tard, six heures au plus. */
const ABANDON_MS = 6 * 3_600_000;

let file: Reprise[] = [];
let demarre = false;
let principale = false;
let minuteur: number | null = null;
let traitement = false;
const abonnes = new Set<() => void>();
const enCours = new Set<string>();

function stockage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function notifier(genre: "fini" | "attente" | "echec" | "info", titre: string, texte: string, sessionId?: string) {
  window.dispatchEvent(new CustomEvent("ide-notification", { detail: { genre, titre, texte, sessionId } }));
}

function appelDemon<T>(method: string, params: unknown): Promise<T> {
  return invoke<T>("daemon_call", { input: { connection: "local", method, params } });
}

function prevenir() {
  for (const f of abonnes) f();
}

function changer(suite: Reprise[]) {
  file = suite;
  ecrireFile(stockage(), file);
  prevenir();
  programmer();
}

/** Reprises prévues (toutes les sessions). */
export function reprisesPrevues(): readonly Reprise[] {
  return file;
}

export function abonnerReprises(f: () => void): () => void {
  abonnes.add(f);
  return () => {
    abonnes.delete(f);
  };
}

export function annulerReprise(sessionId: string): void {
  const r = file.find((x) => x.sessionId === sessionId);
  changer(annuler(file, sessionId));
  if (r) notifier("info", "Reprise automatique annulée", `«\u00a0${r.nom}\u00a0» ne reprendra pas seule.`, sessionId);
}

/** Message d'une erreur de tour : flux en direct (`turn_error`) ou entrée du journal. */
function erreurDe(p: EvenementDemon): string | null {
  if (p.event === "stream") {
    const ev = p.data?.event;
    return ev?.type === "turn_error" && typeof ev.error === "string" ? ev.error : null;
  }
  if (p.event === "entry") {
    const d = p.data;
    return d?.kind === "extension" && d?.name === "turn_error" && typeof d?.payload?.error === "string" ? d.payload.error : null;
  }
  return null;
}

async function surErreur(sessionId: string, erreur: string) {
  // Le flux et le journal signalent la même erreur : un seul traitement.
  if (!estLimite(erreur) || enCours.has(sessionId)) return;
  enCours.add(sessionId);
  try {
    const meta = await appelDemon<MetaSession>("sessions.get", { sessionId }).catch(() => null);
    const provider = meta?.model?.provider ?? "";
    const report = await invoke<QuotaReport>("provider_quota", { input: { force: true } }).catch(() => null);
    if (!provider || !estAbonnement(provider, report)) return;
    const maintenant = Date.now();
    const nom = meta?.name?.trim() || "Conversation";
    const essais = essaiSuivant(lirePrecedentes(stockage()), sessionId, maintenant);
    if (essais >= MAX_ESSAIS) {
      notifier(
        "echec",
        "Reprise automatique arrêtée",
        `«\u00a0${nom}\u00a0»\u00a0: la limite revient après ${MAX_ESSAIS} reprises. Relancez-la quand vous voudrez.`,
        sessionId,
      );
      return;
    }
    const { aMs, source } = heureReprise(provider, report, maintenant);
    changer(planifier(file, { sessionId, parentId: meta?.parentId ?? null, nom, provider, aMs, source, essais, creeMs: maintenant }));
    notifier("attente", "Limite de l'abonnement atteinte", `«\u00a0${nom}\u00a0» reprendra seule à ${heureCourte(aMs, maintenant)}.`, sessionId);
  } finally {
    window.setTimeout(() => enCours.delete(sessionId), 10_000);
  }
}

async function relancer(r: Reprise) {
  let meta: MetaSession | null;
  try {
    meta = await appelDemon<MetaSession>("sessions.get", { sessionId: r.sessionId });
  } catch (err) {
    const disparue = /not found|introuvable/i.test(String(err));
    changer(disparue || Date.now() - r.aMs > ABANDON_MS ? annuler(file, r.sessionId) : planifier(file, { ...r, aMs: Date.now() + 60_000 }));
    return;
  }
  changer(annuler(file, r.sessionId));
  // Déjà relancée à la main : rien à faire.
  if (!meta || meta.status === "running") return;
  try {
    await appelDemon("sessions.send", { sessionId: r.sessionId, text: TEXTE_REPRISE });
    noterPrecedente(stockage(), r, Date.now());
    notifier("info", "Reprise automatique", `«\u00a0${r.nom}\u00a0» reprend\u00a0: la limite est réinitialisée.`, r.sessionId);
  } catch {
    if (Date.now() - r.aMs <= ABANDON_MS) changer(planifier(file, { ...r, aMs: Date.now() + 60_000 }));
  }
}

async function echeance() {
  if (traitement) return;
  traitement = true;
  try {
    for (let r = echues(file, Date.now())[0]; r; r = echues(file, Date.now())[0]) {
      await relancer(r);
    }
  } finally {
    traitement = false;
    programmer();
  }
}

function programmer() {
  if (!principale || traitement) return;
  if (minuteur !== null) window.clearTimeout(minuteur);
  minuteur = null;
  if (file.length === 0) return;
  const prochaine = Math.min(...file.map((r) => r.aMs));
  const delai = Math.max(0, Math.min(prochaine - Date.now(), VERIFICATION_MS));
  minuteur = window.setTimeout(() => {
    minuteur = null;
    void echeance();
  }, delai);
}

function surStockage(e: StorageEvent) {
  if (e.key !== CLE_FILE) return;
  file = lireFile(stockage());
  prevenir();
  programmer();
}

/** Démarre la surveillance (une fois par fenêtre ; seule la principale relance). */
export function demarrerRepriseAuto(): void {
  if (demarre) return;
  demarre = true;
  file = lireFile(stockage());
  try {
    principale = getCurrentWindow().label === "main";
  } catch {
    principale = false;
  }
  window.addEventListener("storage", surStockage);
  if (!principale) return;
  void listen<EvenementDemon>("axe://daemon", (e) => {
    const p = e.payload;
    // Service local seulement : les quotas lus sont ceux des comptes de ce poste.
    if (!p?.sessionId || p.connectionId) return;
    const erreur = erreurDe(p);
    if (erreur) void surErreur(p.sessionId, erreur);
  }).catch(() => undefined);
  programmer();
}

// axe:file-demon — la file d'attente vit dans le service (démon local ou
// espace distant), par session : il envoie le message suivant à la fin du
// tour, quel que soit le dossier ou l'onglet ouvert dans l'IDE. Le front n'en
// garde qu'une copie d'affichage (magasin fileAttente, sans stockage), tenue à
// jour par l'événement « queue » du service.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { filesPartagees, PREFIXE_CLE_FILE, relireFile, type ElementFile } from "./fileAttente";

export type ElementDemon = {
  id: string;
  text: string;
  model?: unknown;
  display?: Record<string, unknown> | null;
  createdAtMs?: number;
};

/** Élément du service -> élément affiché (pièces jointes, réglages : `display`). */
export function versAffichage<T extends ElementFile>(item: ElementDemon): T {
  const d = (item.display ?? {}) as Record<string, unknown>;
  return {
    ...d,
    id: item.id,
    text: item.text,
    attachments: Array.isArray(d.attachments) ? d.attachments : [],
    model: d.model ?? item.model,
    createdAtMs: item.createdAtMs ?? 0,
  } as unknown as T;
}

async function appel<T>(workspacePath: string, method: string, params: unknown): Promise<T> {
  const connection = cloudConnectionFromPath(workspacePath);
  return invoke<T>("daemon_call", { input: { connection, method, params } });
}

export type ElementAPousser = ElementFile & {
  model: unknown;
  thinking: unknown;
  mode: unknown;
  serviceTier: unknown;
  createdAtMs?: number;
};

export async function pousserFile(
  workspacePath: string,
  conversationId: string,
  element: ElementAPousser,
  index?: number,
): Promise<void> {
  const { id, text, attachments, model, thinking, mode, serviceTier, createdAtMs } = element;
  await invoke("queue_push", {
    input: {
      message: { workspacePath, conversationId, text, attachments, model, thinking, mode, serviceTier },
      itemId: id,
      index,
      display: { attachments, model, thinking, mode, serviceTier, createdAtMs },
    },
  });
}

export function retirerFile(workspacePath: string, conversationId: string, itemId: string) {
  return appel(workspacePath, "queue.remove", { sessionId: conversationId, itemId });
}

export function deplacerFile(workspacePath: string, conversationId: string, itemId: string, index: number) {
  return appel(workspacePath, "queue.move", { sessionId: conversationId, itemId, index });
}

// axe:file-pause — après un Stop, le service met la file en pause ; le
// bouton « Reprendre la file » la relance (queue.resume).
const PAUSES = new Set<string>();
const ABONNES_PAUSE = new Set<() => void>();
let versionPauses = 0;
export function abonnerPauses(f: () => void): () => void {
  ABONNES_PAUSE.add(f);
  return () => ABONNES_PAUSE.delete(f);
}
export function instantanePauses(): number {
  return versionPauses;
}
export function fileEnPause(conversationId: string): boolean {
  return PAUSES.has(conversationId);
}
export function noterPause(conversationId: string, paused: boolean | undefined): void {
  if (paused === undefined || PAUSES.has(conversationId) === paused) return;
  if (paused) PAUSES.add(conversationId);
  else PAUSES.delete(conversationId);
  versionPauses += 1;
  for (const f of ABONNES_PAUSE) f();
}
export async function reprendreFile(workspacePath: string, conversationId: string): Promise<void> {
  noterPause(conversationId, false);
  await appel(workspacePath, "queue.resume", { sessionId: conversationId });
}

/** Relit la file du service pour une conversation (copie d'affichage). */
export async function relireFileDemon(workspacePath: string, conversationId: string): Promise<void> {
  try {
    const st = await appel<{ items?: ElementDemon[]; paused?: boolean }>(workspacePath, "queue.state", {
      sessionId: conversationId,
    });
    appliquer(conversationId, st?.items ?? [], st?.paused ?? false);
  } catch {
    // service plus ancien (sans queue.state)
    const items = await appel<ElementDemon[]>(workspacePath, "queue.list", { sessionId: conversationId });
    appliquer(conversationId, items ?? []);
  }
}

function appliquer(conversationId: string, items: ElementDemon[], paused?: boolean) {
  filesPartagees().modifierFile(conversationId, () => items.map((i) => versAffichage(i)));
  noterPause(conversationId, items.length === 0 ? false : paused);
}

let ecoute = false;
/** Une fois par appli : les événements « queue » du service mettent la copie à jour. */
export function ecouterFilesDemon(): void {
  if (ecoute) return;
  ecoute = true;
  void listen<{ event?: string; sessionId?: string; data?: { sessionId?: string; items?: ElementDemon[]; paused?: boolean } }>(
    "axe://daemon",
    (e) => {
      const p = e.payload;
      if (p?.event !== "queue") return;
      const id = p.data?.sessionId ?? p.sessionId;
      if (id) appliquer(id, p.data?.items ?? [], p.data?.paused);
    },
  ).catch(() => {
    ecoute = false;
  });
}

/**
 * Migration : l'ancienne file du navigateur (localStorage) de chaque
 * conversation de cet espace part dans le service, puis est effacée.
 * Ce qui échoue reste dans le navigateur pour un essai suivant.
 */
export async function migrerFilesNavigateur(
  workspacePath: string,
  conversationIds: readonly string[],
  stockage: Storage | null = typeof window !== "undefined" ? window.localStorage : null,
): Promise<number> {
  if (!stockage) return 0;
  let n = 0;
  for (const conversationId of conversationIds) {
    const cle = `${PREFIXE_CLE_FILE}${conversationId}`;
    let brut: string | null = null;
    try {
      brut = stockage.getItem(cle);
    } catch {
      continue;
    }
    const file = relireFile<ElementAPousser>(brut);
    if (file.length === 0) continue;
    try {
      for (const element of file) {
        await pousserFile(workspacePath, conversationId, element);
        n += 1;
      }
      stockage.removeItem(cle);
    } catch (err) {
      console.error("migration de la file", err);
    }
  }
  return n;
}

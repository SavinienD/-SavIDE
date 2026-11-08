// Revue des changements : envoi d'UN message dans une conversation du dossier, par la file
// du service (même chemin qu'un message mis en file depuis la saisie : il part tout de
// suite si l'agent est libre, sinon à la fin du tour en cours).
import { api } from "../../lib/ipc";
import { modelIdFromRef, modelRefFromId, thinkingFromRef } from "../../lib/models";
import type { ConversationSummary, ModelRef } from "../../types";
import { pousserFile } from "../chat/fileDemon";

/** Conversations actives du dossier, la plus récente d'abord. */
export async function conversationsDuDossier(dossier: string): Promise<ConversationSummary[]> {
  const liste = await api.listConversations(dossier);
  return [...liste].filter((c) => !c.archived).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

/** Modèle de la conversation (mode Agir), sans l'effort qui part à part. */
export function modeleDeConversation(model: ModelRef, actes?: ModelRef | null): { model: ModelRef; thinking: string } {
  const ref = actes ?? model;
  return { model: modelRefFromId(modelIdFromRef(ref)), thinking: thinkingFromRef(ref) };
}

let compteur = 0;

export async function envoyerDansConversation(dossier: string, conversationId: string, texte: string): Promise<void> {
  const conversation = await api.loadConversation(dossier, conversationId);
  const { model, thinking } = modeleDeConversation(conversation.model, conversation.modeModelSettings?.act);
  compteur += 1;
  await pousserFile(dossier, conversationId, {
    id: `revue-${Date.now().toString(36)}-${compteur}`,
    text: texte,
    attachments: [],
    model,
    thinking,
    mode: "act",
    serviceTier: null,
    createdAtMs: Date.now(),
  });
}

/** Notification de l'IDE (événement « ide-notification »). */
export function notifier(genre: "fini" | "attente" | "echec" | "info", titre: string, texte: string, dossier?: string, sessionId?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("ide-notification", { detail: { genre, titre, texte, dossier, sessionId } }));
}

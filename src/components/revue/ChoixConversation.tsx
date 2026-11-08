// Revue des changements : choix de la conversation qui reçoit le message (par défaut la plus récente du dossier).
import { useCallback, useEffect, useState } from "react";
import type { ConversationSummary } from "../../types";
import { conversationsDuDossier } from "./envoi";

export function useConversationsDuDossier(dossier: string) {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [cible, setCible] = useState("");
  const recharger = useCallback(() => {
    conversationsDuDossier(dossier)
      .then((liste) => {
        setConversations(liste);
        setCible((c) => (c && liste.some((x) => x.id === c) ? c : liste[0]?.id ?? ""));
      })
      .catch(() => setConversations([]));
  }, [dossier]);
  useEffect(() => recharger(), [recharger]);
  const titre = conversations?.find((c) => c.id === cible)?.title || "conversation";
  return { conversations, cible, setCible, recharger, titre };
}

export function ChoixConversation({ etat, compact = false }: { etat: ReturnType<typeof useConversationsDuDossier>; compact?: boolean }) {
  const { conversations, cible, setCible, recharger } = etat;
  return (
    <label className={compact ? "revue-champ revue-champ--base" : "revue-champ"}>
      <span>Conversation</span>
      <select value={cible} onChange={(e) => setCible(e.target.value)} disabled={!conversations?.length} onFocus={recharger} aria-label="Conversation qui reçoit le message">
        {conversations === null ? <option value="">Chargement…</option> : null}
        {conversations?.length === 0 ? <option value="">Aucune conversation dans ce dossier</option> : null}
        {conversations?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title || "Sans titre"}
          </option>
        ))}
      </select>
    </label>
  );
}

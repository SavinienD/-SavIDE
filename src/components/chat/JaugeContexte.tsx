// Jauge du contexte et minuteur du cache de prompt, discrets, dans l'en-tête du chat :
// jetons du dernier appel au modèle sur la fenêtre du modèle (repère : seuil de la compaction
// automatique) et temps restant du cache (5 min ou 1 h selon le fournisseur).
// Lit `sessions.context` à l'ouverture et à chaque fin de tour, puis suit l'événement de flux
// `contexte` (axe://daemon) émis après chaque appel. Logique : jaugeContexteDonnees.ts.
import { useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { delaiRafraichissement, etatCache, etatJauge, lireAppel, type DernierAppel } from "./jaugeContexteDonnees";
import "./jaugeContexte.css";

type Props = {
  workspacePath: string;
  conversationId: string;
  /** Fenêtre du modèle choisi, quand le service ne la connaît pas encore. */
  fenetreModele?: number;
  /** Change à chaque début et fin de tour : relecture. */
  signal?: unknown;
};

/** Dernier état connu par conversation (changer d'onglet ne vide pas la jauge). */
const memoire = new Map<string, DernierAppel | null>();

type EvenementDemon = { event?: string; sessionId?: string; data?: { event?: { type?: string; appel?: unknown } } };

export function JaugeContexte({ workspacePath, conversationId, fenetreModele, signal }: Props) {
  const [appel, setAppel] = useState<DernierAppel | null>(() => memoire.get(conversationId) ?? null);
  const [maintenant, setMaintenant] = useState(() => Date.now());

  useEffect(() => {
    setAppel(memoire.get(conversationId) ?? null);
    let annule = false;
    const connection = cloudConnectionFromPath(workspacePath) ?? "local";
    invoke<unknown>("daemon_call", { input: { connection, method: "sessions.context", params: { sessionId: conversationId } } })
      .then((brut) => {
        if (annule) return;
        const lu = lireAppel(brut);
        memoire.set(conversationId, lu);
        setAppel(lu);
        setMaintenant(Date.now());
      })
      .catch(() => {
        // Service plus ancien ou conversation inconnue : la jauge reste vide.
      });
    return () => {
      annule = true;
    };
  }, [workspacePath, conversationId, signal]);

  useEffect(() => {
    let arreter: (() => void) | null = null;
    let fini = false;
    void listen<EvenementDemon>("axe://daemon", (e) => {
      const p = e.payload;
      if (p?.event !== "stream" || p.sessionId !== conversationId || p.data?.event?.type !== "contexte") return;
      const lu = lireAppel(p.data.event.appel);
      if (!lu) return;
      memoire.set(conversationId, lu);
      setAppel(lu);
      setMaintenant(Date.now());
    })
      .then((u) => {
        if (fini) u();
        else arreter = u;
      })
      .catch(() => undefined);
    return () => {
      fini = true;
      arreter?.();
    };
  }, [conversationId]);

  const delai = delaiRafraichissement(appel, maintenant);
  useEffect(() => {
    if (delai === null) return;
    const t = window.setTimeout(() => setMaintenant(Date.now()), delai);
    return () => window.clearTimeout(t);
  }, [delai, maintenant]);

  const jauge = etatJauge(appel, fenetreModele ?? 0);
  const cache = etatCache(appel, maintenant);
  if (!jauge && !cache) return null;
  return (
    <span className="jauge-contexte" data-testid="jauge-contexte">
      {jauge && (
        <span className="jauge-contexte__jauge" data-ton={jauge.ton} tabIndex={0} title={jauge.detail} aria-label={jauge.detail}>
          <span className="jauge-contexte__barre" aria-hidden>
            <span style={{ width: `${jauge.pourcent}%` }} />
            {jauge.seuilPourcent !== null && <i style={{ left: `${jauge.seuilPourcent}%` }} />}
          </span>
          <span className="jauge-contexte__pct">{jauge.libelle}</span>
        </span>
      )}
      {cache && (
        <span
          className="jauge-contexte__cache"
          data-expire={cache.expire ? "true" : "false"}
          tabIndex={0}
          title={cache.detail}
          aria-label={cache.detail}
        >
          <Icon icon="solar:clock-circle-linear" width={12} height={12} aria-hidden />
          {cache.texte}
        </span>
      )}
    </span>
  );
}

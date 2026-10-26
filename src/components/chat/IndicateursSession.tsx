// axe:commandes — petites icônes /heartbeat et /goal à côté du sélecteur de modèle :
// intervalle et prochain réveil (clignote au déclenchement), texte et statut du goal ;
// un clic ouvre le détail avec les boutons pour les arrêter.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { cloudConnectionFromPath } from "../../lib/ipc";
import {
  ETAT_VIDE,
  detailGuet,
  formatHeure,
  formatIntervalle,
  libelleStatutGoal,
  normaliserEtat,
  textePoursuite,
  vientDeSeDeclencher,
  type EtatCommandes,
} from "./logiqueIndicateurs";
import "./indicateurs.css";

const LECTURE_MS = 5_000;
const CLIGNOTEMENT_MS = 4_000;

type Props = {
  workspacePath: string;
  conversationId: string;
  /** Change à chaque tour / réveil : relecture immédiate (et clignotement si réveil). */
  signal?: string | number;
  /** Identifiant du dernier réveil affiché : clignote quand il change. */
  dernierReveil?: string | null;
};

function appel<T>(workspacePath: string, method: string, params: unknown): Promise<T> {
  const connection = cloudConnectionFromPath(workspacePath) ?? "local";
  return invoke<T>("daemon_call", { input: { connection, method, params } });
}

export function IndicateursSession({ workspacePath, conversationId, signal, dernierReveil }: Props) {
  const [etat, setEtat] = useState<EtatCommandes>(ETAT_VIDE);
  const [ouvert, setOuvert] = useState<"heartbeat" | "goal" | "guet" | null>(null);
  const [clignote, setClignote] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const precedent = useRef<EtatCommandes>(ETAT_VIDE);
  const racine = useRef<HTMLDivElement | null>(null);
  const detail = useRef<HTMLDivElement | null>(null);
  // Le détail est posé sur <body> (position fixe) : la colonne de conversation rogne
  // tout ce qui dépasse du compositeur (banc 800x600 : haut du détail invisible).
  const [place, setPlace] = useState<CSSProperties>({});
  const ouvrir = (quoi: "heartbeat" | "goal" | "guet", bouton: HTMLElement) => {
    if (ouvert === quoi) {
      setOuvert(null);
      return;
    }
    const r = bouton.getBoundingClientRect();
    const largeur = 260;
    setPlace({
      position: "fixed",
      left: Math.max(8, Math.min(r.left, window.innerWidth - largeur - 8)),
      bottom: Math.max(8, window.innerHeight - r.top + 6),
      width: largeur,
    });
    setOuvert(quoi);
  };

  const clignoter = useCallback(() => {
    setClignote(true);
    window.setTimeout(() => setClignote(false), CLIGNOTEMENT_MS);
  }, []);

  const lire = useCallback(async () => {
    try {
      const brut = await appel<unknown>(workspacePath, "sessions.commands_state", { sessionId: conversationId });
      const suivant = normaliserEtat(brut);
      if (vientDeSeDeclencher(precedent.current, suivant)) clignoter();
      precedent.current = suivant;
      setEtat(suivant);
    } catch {
      // Conversation pas encore connue du service : aucun indicateur.
      precedent.current = ETAT_VIDE;
      setEtat(ETAT_VIDE);
    }
  }, [workspacePath, conversationId, clignoter]);

  useEffect(() => {
    precedent.current = ETAT_VIDE;
    setEtat(ETAT_VIDE);
    setOuvert(null);
    void lire();
    const t = window.setInterval(() => void lire(), LECTURE_MS);
    return () => window.clearInterval(t);
  }, [lire]);

  useEffect(() => {
    void lire();
  }, [signal, lire]);

  const premierReveil = useRef(true);
  useEffect(() => {
    if (premierReveil.current) {
      premierReveil.current = false;
      return;
    }
    if (dernierReveil) clignoter();
  }, [dernierReveil, clignoter]);

  useEffect(() => {
    if (!ouvert) return;
    const fermer = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (racine.current?.contains(cible) || detail.current?.contains(cible)) return;
      setOuvert(null);
    };
    window.addEventListener("mousedown", fermer);
    return () => window.removeEventListener("mousedown", fermer);
  }, [ouvert]);

  const agir = async (op: string) => {
    setErreur(null);
    try {
      const brut = await appel<unknown>(workspacePath, "sessions.commands_set", { sessionId: conversationId, op });
      const suivant = normaliserEtat(brut);
      precedent.current = suivant;
      setEtat(suivant);
      if (
        (op === "heartbeat_off" && !suivant.heartbeat) ||
        (op === "goal_clear" && !suivant.goal) ||
        (op.startsWith("guet_annuler") && suivant.guets.length === 0)
      )
        setOuvert(null);
    } catch (e) {
      setErreur(String(e));
    }
  };

  const { heartbeat, goal, guets } = etat;
  if (!heartbeat && !goal && guets.length === 0) return null;
  const poursuite = goal ? textePoursuite(goal) : null;
  return (
    <div className="axe-indicateurs" ref={racine}>
      {heartbeat && (
        <button
          type="button"
          className="axe-indicateur"
          data-kind="heartbeat"
          data-clignote={clignote ? "true" : "false"}
          aria-label="Réveil périodique"
          title={`Réveil toutes les ${formatIntervalle(heartbeat.interval_ms)}${
            heartbeat.last_at_ms ? ` · dernier réveil ${formatHeure(heartbeat.last_at_ms)}` : ""
          }${heartbeat.next_at_ms ? ` · prochain réveil ${formatHeure(heartbeat.next_at_ms)}` : ""}`}
          onClick={(e) => ouvrir("heartbeat", e.currentTarget)}
        >
          <Icon icon="solar:heart-pulse-linear" width={15} height={15} />
        </button>
      )}
      {goal && (
        <button
          type="button"
          className="axe-indicateur"
          data-kind="goal"
          data-statut={goal.status}
          aria-label="Objectif"
          title={`Objectif (${libelleStatutGoal(goal.status)}) : ${goal.text}`}
          onClick={(e) => ouvrir("goal", e.currentTarget)}
        >
          <Icon icon="solar:target-linear" width={15} height={15} />
        </button>
      )}
      {guets.length > 0 && (
        <button
          type="button"
          className="axe-indicateur"
          data-kind="guet"
          aria-label={`Guets en cours : ${guets.length}`}
          title={`${guets.length} guet${guets.length > 1 ? "s" : ""} en cours : ${guets.map((g) => g.cible).join(" · ")}`}
          onClick={(e) => ouvrir("guet", e.currentTarget)}
        >
          <Icon icon="solar:eye-scan-linear" width={15} height={15} />
          <span className="axe-indicateur__nombre">{guets.length}</span>
        </button>
      )}
      {ouvert === "guet" && guets.length > 0 && createPortal(
        <div className="axe-indicateurs__detail" role="dialog" aria-label="Guets en cours" ref={detail} style={place}>
          <div className="axe-indicateurs__titre">{`Guet${guets.length > 1 ? "s" : ""} en cours (${guets.length})`}</div>
          {guets.map((g) => (
            <div className="axe-indicateurs__guet" key={g.id} data-guet={g.id}>
              {detailGuet(g).map((l, i) => (
                <div key={i} className={i === 0 ? "axe-indicateurs__message" : undefined}>{l}</div>
              ))}
              {g.message && <div className="axe-indicateurs__resume">{g.message}</div>}
              <div className="axe-indicateurs__actions">
                <button type="button" onClick={() => void agir(`guet_annuler:${g.id}`)}>
                  Annuler
                </button>
              </div>
            </div>
          ))}
          {guets.length > 1 && (
            <div className="axe-indicateurs__actions">
              <button type="button" onClick={() => void agir("guet_annuler")}>
                Tout annuler
              </button>
            </div>
          )}
          {erreur && <div className="axe-indicateurs__erreur">{erreur}</div>}
        </div>,
        document.body,
      )}
      {ouvert === "heartbeat" && heartbeat && createPortal(
        <div className="axe-indicateurs__detail" role="dialog" aria-label="Réveil périodique" ref={detail} style={place}>
          <div className="axe-indicateurs__titre">Réveil périodique</div>
          <div>{`Toutes les ${formatIntervalle(heartbeat.interval_ms)}`}</div>
          {heartbeat.last_at_ms ? <div>{`Dernier réveil : ${formatHeure(heartbeat.last_at_ms, true)}`}</div> : null}
          {heartbeat.next_at_ms > 0 && <div>{`Prochain réveil : ${formatHeure(heartbeat.next_at_ms, true)}`}</div>}
          <div className="axe-indicateurs__message">« {heartbeat.message} »</div>
          <div className="axe-indicateurs__actions">
            <button type="button" onClick={() => void agir("heartbeat_off")}>
              Arrêter le réveil
            </button>
          </div>
          {erreur && <div className="axe-indicateurs__erreur">{erreur}</div>}
        </div>,
        document.body,
      )}
      {ouvert === "goal" && goal && createPortal(
        <div className="axe-indicateurs__detail" role="dialog" aria-label="Objectif" ref={detail} style={place}>
          <div className="axe-indicateurs__titre">Objectif : {libelleStatutGoal(goal.status)}</div>
          <div className="axe-indicateurs__message">{goal.text}</div>
          {poursuite && <div className="axe-indicateurs__poursuite">{poursuite}</div>}
          {goal.summary && <div className="axe-indicateurs__resume">{goal.summary}</div>}
          <div className="axe-indicateurs__actions">
            {goal.status === "active" && (
              <button type="button" onClick={() => void agir("goal_pause")}>
                Mettre en pause
              </button>
            )}
            {goal.status === "paused" && (
              <button type="button" onClick={() => void agir("goal_resume")}>
                Reprendre
              </button>
            )}
            <button type="button" onClick={() => void agir("goal_clear")}>
              Arrêter l'objectif
            </button>
          </div>
          {erreur && <div className="axe-indicateurs__erreur">{erreur}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}

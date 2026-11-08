// mode « Demander avant d'agir » : actions de l'agent (cellules python)
// en attente d'accord, montrées au-dessus de la zone de saisie de la conversation
// (les siennes et celles de ses sous-agents). Autoriser, Refuser (avec un motif
// renvoyé à l'agent) ou Toujours pour cette conversation. Ctrl+Maj+Entrée autorise.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cloudConnectionFromPath } from "../../lib/ipc";
import { fournirActions, infoBulle } from "../../axe/raccourcis";
import {
  abonner,
  appliquerEvenement,
  doitNotifier,
  monterVue,
  notification,
  parametresReponse,
  pourConversation,
  remplacer,
  retirer,
  versionDemandes,
  vuesMontees,
  type DecisionValidation,
  type Demande,
  type EntreeDemande,
} from "../../lib/validationActions";
import "../settings/interop.css";

const appel = <T,>(method: string, params: unknown, connexion: string | null) =>
  invoke<T>("daemon_call", { input: { method, params, connection: connexion } });

function notifier(d: Demande): void {
  const visible = typeof document === "undefined" || document.visibilityState === "visible";
  if (doitNotifier(d, vuesMontees(), visible)) {
    window.dispatchEvent(new CustomEvent("ide-notification", { detail: notification(d) }));
  }
}

let ecoute = false;
/** Une fois par appli : les demandes et leurs fins arrivent par le flux du service. */
function ecouterValidations(): void {
  if (ecoute) return;
  ecoute = true;
  void listen("axe://daemon", (e) => {
    const nouvelle = appliquerEvenement(e.payload as Parameters<typeof appliquerEvenement>[0]);
    if (nouvelle) notifier(nouvelle);
  }).catch(() => {
    ecoute = false;
  });
  // Ctrl+Maj+Entrée : autorise l'action en attente de la conversation qui a le focus.
  fournirActions({
    validerAction: () => {
      const actif = document.activeElement?.closest?.("[data-conversation-validation]");
      const id = actif?.getAttribute("data-conversation-validation");
      const vues = [...vuesMontees()];
      const cible = (id ? pourConversation(id) : vues.flatMap((v) => pourConversation(v)))[0];
      if (!cible) return false;
      void repondre(cible, "autoriser");
    },
  });
}

async function repondre(e: EntreeDemande, decision: DecisionValidation, motif?: string): Promise<void> {
  await appel("approbation.repondre", parametresReponse(e.demande.id, decision, motif), e.connexion);
  retirer(e.demande.id);
}

type Props = { workspacePath: string; conversationId: string };

export function ValidationActions({ workspacePath, conversationId }: Props) {
  useSyncExternalStore(abonner, versionDemandes);
  const [choisie, setChoisie] = useState<string | null>(null);
  const connexion = cloudConnectionFromPath(workspacePath);

  useEffect(() => {
    ecouterValidations();
    const fin = monterVue(conversationId);
    let vivant = true;
    // Demandes déjà en attente (appli rouverte, conversation affichée plus tard).
    appel<Demande[]>("approbation.liste", {}, connexion)
      .then((liste) => {
        if (vivant) remplacer(Array.isArray(liste) ? liste : [], connexion);
      })
      .catch(() => undefined);
    return () => {
      vivant = false;
      fin();
    };
  }, [conversationId, connexion]);

  const entrees = pourConversation(conversationId);
  if (entrees.length === 0) return null;
  // Une carte à la fois (la plus ancienne, ou celle choisie) : les autres en une ligne, au-dessus.
  const montree = entrees.find((e) => e.demande.id === choisie) ?? entrees[0];
  const autres = entrees.filter((e) => e !== montree);
  return (
    <div className="axe-validation" data-conversation-validation={conversationId}>
      {autres.length ? (
        <div className="axe-validation__autres">
          <span>{autres.length === 1 ? "Autre action en attente :" : `${autres.length} autres actions en attente :`}</span>
          {autres.map((e) => (
            <button key={e.demande.id} type="button" className="axe-validation__autre" data-action="voir-demande" title={e.demande.code} onClick={() => setChoisie(e.demande.id)}>
              {e.demande.sessionId === conversationId && !e.demande.parentId ? "cette conversation" : e.demande.nomSession}
            </button>
          ))}
        </div>
      ) : null}
      <CarteValidation key={montree.demande.id} entree={montree} conversationId={conversationId} />
    </div>
  );
}

function CarteValidation({ entree, conversationId }: { entree: EntreeDemande; conversationId: string }) {
  const d = entree.demande;
  const [refus, setRefus] = useState(false);
  const [motif, setMotif] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const champ = useRef<HTMLInputElement>(null);
  const sousAgent = d.sessionId !== conversationId || !!d.parentId;

  useEffect(() => {
    if (refus) champ.current?.focus();
  }, [refus]);

  const agir = async (decision: DecisionValidation) => {
    setOccupe(true);
    setErreur(null);
    try {
      await repondre(entree, decision, motif);
    } catch (err) {
      setErreur(String(err));
      setOccupe(false);
    }
  };

  return (
    <section className="axe-validation__carte" aria-label="Action à valider" data-demande={d.id}>
      <header className="axe-validation__tete">
        <Icon icon="solar:shield-warning-linear" width={15} height={15} />
        <strong title={sousAgent ? `Sous-agent « ${d.nomSession} »` : undefined}>
          {sousAgent ? `Sous-agent « ${d.nomSession} »` : "L'agent veut exécuter"}
        </strong>
        <span className="axe-validation__outil">cellule python</span>
      </header>
      <pre className="axe-validation__code" tabIndex={0} aria-label="Code à exécuter">{d.code}</pre>
      {refus ? (
        <form
          className="axe-validation__refus"
          onSubmit={(ev) => {
            ev.preventDefault();
            void agir("refuser");
          }}
        >
          <input
            ref={champ}
            value={motif}
            onChange={(ev) => setMotif(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Escape") {
                ev.preventDefault();
                setRefus(false);
              }
            }}
            maxLength={2000}
            placeholder="Motif renvoyé à l'agent (facultatif)"
            aria-label="Motif du refus"
          />
          <button type="submit" className="axe-harness__btn axe-harness__btn--danger" data-action="refuser-confirmer" disabled={occupe}>
            Refuser
          </button>
          <button type="button" className="axe-harness__btn" onClick={() => setRefus(false)} disabled={occupe}>
            Annuler
          </button>
        </form>
      ) : (
        <div className="axe-validation__actions">
          <button
            type="button"
            className="axe-harness__btn axe-harness__btn--primary"
            data-action="autoriser"
            title={infoBulle("Autoriser", "validerAction")}
            disabled={occupe}
            onClick={() => void agir("autoriser")}
          >
            Autoriser
          </button>
          <button type="button" className="axe-harness__btn" data-action="refuser" disabled={occupe} onClick={() => setRefus(true)}>
            Refuser…
          </button>
          <button
            type="button"
            className="axe-harness__btn"
            data-action="toujours"
            aria-label={sousAgent ? "Toujours pour cet agent" : "Toujours pour cette conversation"}
            title={sousAgent ? "Autoriser, et ne plus demander pour ce sous-agent" : "Autoriser, et ne plus demander dans cette conversation"}
            disabled={occupe}
            onClick={() => void agir("toujours")}
          >
            <span className="axe-validation__long">{sousAgent ? "Toujours pour cet agent" : "Toujours pour cette conversation"}</span>
            <span className="axe-validation__court">Toujours</span>
          </button>
        </div>
      )}
      {erreur ? <p className="axe-harness__error">{erreur}</p> : null}
    </section>
  );
}

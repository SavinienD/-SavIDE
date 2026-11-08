// Réglages > Notifications : événements, notification du système, son court,
// ne pas déranger, essai. Les réglages vivent dans le centre (src-tauri/src/notifications.rs).
import { useEffect, useState } from "react";
import { notificationsApi, type ReglagesNotif } from "./notificationsApi";
import { useCentreNotifications } from "./store";
import { jouerSon } from "./son";
import "./notifications.css";

type Case = { cle: keyof ReglagesNotif; libelle: string; aide?: string };

const EVENEMENTS: Case[] = [
  { cle: "fini", libelle: "Un agent a fini", aide: "Tour lancé par vous ou par le résultat d'un sous-agent ; pas les réveils /heartbeat." },
  { cle: "attente", libelle: "Un agent attend votre réponse", aide: "Question posée par l'agent, demande de validation." },
  { cle: "echec", libelle: "Un tour a échoué" },
  { cle: "sousAgents", libelle: "Fin et échec des sous-agents aussi", aide: "Leurs questions préviennent toujours." },
];

const MANIERES: Case[] = [
  { cle: "systeme", libelle: "Notifications du système", aide: "Seulement si la fenêtre n'a pas le focus ou si la conversation n'est pas affichée. Un clic ouvre la conversation." },
  { cle: "son", libelle: "Son court" },
  { cle: "nePasDeranger", libelle: "Ne pas déranger", aide: "Ni notification ni son : tout reste dans la cloche." },
];

export function NotificationsSection() {
  const { reglages } = useCentreNotifications();
  const [brouillon, setBrouillon] = useState<ReglagesNotif>(reglages);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => setBrouillon(reglages), [reglages]);

  const changer = (cle: keyof ReglagesNotif, valeur: boolean) => {
    const suite = { ...brouillon, [cle]: valeur };
    setBrouillon(suite);
    void notificationsApi.reglages(suite).catch((e) => setMessage(String(e)));
  };
  const essayer = async () => {
    setMessage(null);
    try {
      const decision = await notificationsApi.essayer();
      if (decision?.son) jouerSon("fini");
      setMessage(decision?.systeme ? "Notification envoyée." : "Ajoutée à la cloche.");
    } catch (e) {
      setMessage(String(e));
    }
  };
  const ligne = ({ cle, libelle, aide }: Case) => (
    <label key={cle} className="axe-notifs-reglages__case" data-reglage={cle}>
      <input type="checkbox" checked={Boolean(brouillon[cle])} onChange={(e) => changer(cle, e.target.checked)} />
      <span className="axe-notifs-reglages__texte">
        <span>{libelle}</span>
        {aide ? <span className="axe-notifs-reglages__aide">{aide}</span> : null}
      </span>
      {cle === "son" ? (
        <button type="button" className="axe-notifs-reglages__bouton" onClick={(e) => { e.preventDefault(); jouerSon("fini"); }}>
          Écouter
        </button>
      ) : null}
    </label>
  );
  return (
    <div className="axe-notifs-reglages" data-section="notifications">
      <header>
        <h2>Notifications</h2>
        <p className="axe-notifs-reglages__aide">Quand un agent finit, attend votre réponse ou échoue.</p>
      </header>
      <section className="axe-notifs-reglages__bloc" aria-label="Événements">
        <h3>Événements</h3>
        {EVENEMENTS.map(ligne)}
      </section>
      <section className="axe-notifs-reglages__bloc" aria-label="Alertes">
        <h3>Alertes</h3>
        {MANIERES.map(ligne)}
      </section>
      <div className="axe-notifs-reglages__ligne">
        <button type="button" className="axe-notifs-reglages__bouton" data-action="essayer" onClick={() => void essayer()}>
          Envoyer une notification d'essai
        </button>
        {message ? <span className="axe-notifs-reglages__aide" role="status">{message}</span> : null}
      </div>
    </div>
  );
}

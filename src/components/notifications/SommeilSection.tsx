// Réglages > Notifications : délai après lequel une conversation inactive est
// endormie (son noyau Python s'arrête pour libérer la mémoire ; il repart au message suivant).
// Réglage du service de ce poste (crates/axecode-daemon/src/sommeil.rs, RPC sommeil.get/set).
// Vérifié (python/tests/test_sommeil.py) : un nouveau noyau reprend les variables de l'instantané,
// sauf fichiers ouverts, connexions et processus : l'endormissement reste donc actif par défaut.
import { useEffect, useState } from "react";
import { agentsApi } from "../agents/agentsApi";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import "./notifications.css";

export type EtatSommeil = { conversationsMinutes: number | null; defautMinutes: number };

const CHOIX = [5, 15, 30, 60, 120, 240, 0];

export function libelleDelai(minutes: number): string {
  if (minutes === 0) return "Jamais";
  if (minutes < 60) return `${minutes} min`;
  return `${minutes / 60} h`;
}

export function SommeilSection() {
  const [etat, setEtat] = useState<EtatSommeil | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    void agentsApi
      .call<EtatSommeil | null>("sommeil.get", {}, LOCAL_CONNECTION)
      .then((e) => setEtat(e ?? { conversationsMinutes: null, defautMinutes: 30 }))
      .catch((e) => setErreur(`Réglage indisponible (${String(e)}).`));
  }, []);
  const choisir = (valeur: string) => {
    setErreur(null);
    const conversationsMinutes = valeur === "defaut" ? null : Number(valeur);
    void agentsApi
      .call<EtatSommeil | null>("sommeil.set", { conversationsMinutes }, LOCAL_CONNECTION)
      .then((e) => setEtat(e ?? { conversationsMinutes, defautMinutes: etat?.defautMinutes ?? 30 }))
      .catch((e) => setErreur(String(e)));
  };
  const defaut = etat?.defautMinutes ?? 30;
  const valeur = etat?.conversationsMinutes == null ? "defaut" : String(etat.conversationsMinutes);
  return (
    <section className="axe-notifs-reglages axe-sommeil" data-section="sommeil" aria-label="Conversations inactives">
      <h3>Conversations inactives</h3>
      <div className="axe-notifs-reglages__ligne">
        <span id="axe-sommeil-libelle">Endormir une conversation inactive après</span>
        <select className="axe-sommeil__delai" aria-labelledby="axe-sommeil-libelle" value={valeur} disabled={!etat} onChange={(e) => choisir(e.target.value)}>
          <option value="defaut">{libelleDelai(defaut)} (par défaut)</option>
          {CHOIX.filter((m) => m !== defaut).map((m) => (
            <option key={m} value={String(m)}>
              {libelleDelai(m)}
            </option>
          ))}
        </select>
      </div>
      <p className="axe-notifs-reglages__aide">
        Son noyau Python s'arrête et libère la mémoire ; il repart au message suivant. Les variables sont reprises,
        sauf les fichiers ouverts, les connexions et les processus lancés. Bouton « Endormir » dans l'onglet Agents.
      </p>
      {erreur ? <p className="axe-notifs-reglages__aide" role="alert">{erreur}</p> : null}
    </section>
  );
}

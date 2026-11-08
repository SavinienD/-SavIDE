// automatisations — écran Automatisations (Ctrl+Maj+L) : les automatisations de tous les
// dossiers, prochaine exécution, historique (date, durée, statut, conversation), « Lancer »,
// pause / reprise, modifier, supprimer, et création guidée. Tout se fait au clavier : Tab,
// Entrée, Échap (retour à la liste, puis fermeture).
import { useCallback, useEffect, useRef, useState } from "react";
import { agentsApi } from "../agents/agentsApi";
import { SessionJournal } from "../agents/SessionJournal";
import { getActiveConnection } from "../settings/connectionsApi";
import { fournirActions } from "../../axe/raccourcis";
import { automatisationsApi, type Automatisation, type Execution } from "./automatisationsApi";
import { DECLENCHEURS, STATUTS, dateExecution, duree, messageErreur, nomDossier, prochaineTexte, trier } from "./horaires";
import { FormulaireAutomatisation } from "./FormulaireAutomatisation";
import "./automatisations.css";

type Vue =
  | { genre: "liste" }
  | { genre: "formulaire"; automatisation?: Automatisation }
  | { genre: "journal"; sessionId: string; titre: string };

type Props = {
  /** Dossier ouvert (proposé à la création). */
  dossierCourant?: string;
  onFermer: () => void;
};

// Éléments qui prennent le focus (Tab reste dans l'écran).
const FOCUSABLES = [...["button", "input", "select", "textarea"].map((t) => `${t}:not([disabled])`), "[tabindex]:not([tabindex='-1'])"].join(",");

function LigneExecution({ x, maintenant, onVoir }: { x: Execution; maintenant: number; onVoir: (x: Execution) => void }) {
  const resume = x.resume ?? (x.statut === "en_cours" || x.statut === "verification" ? "En cours…" : "");
  const origine = x.declencheur === "horaire" ? "" : ` · ${DECLENCHEURS[x.declencheur].toLowerCase()}`;
  return (
    <li className="auto-exec">
      <span className="auto-statut" data-statut={x.statut}>{STATUTS[x.statut]}</span>
      <span className="auto-exec__date" title={DECLENCHEURS[x.declencheur]}>
        {dateExecution(x, maintenant)}
        {origine}
      </span>
      <span className="auto-exec__duree">{duree(x.debutMs, x.finMs)}</span>
      <span className="auto-exec__resume" title={resume}>{resume}</span>
      {x.sessionId ? (
        <button type="button" className="auto-btn" data-action="voir" onClick={() => onVoir(x)} title="Voir la conversation de cette exécution">
          Voir
        </button>
      ) : (
        <span />
      )}
    </li>
  );
}

export function EcranAutomatisations({ dossierCourant, onFermer }: Props) {
  const [liste, setListe] = useState<Automatisation[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [vue, setVue] = useState<Vue>({ genre: "liste" });
  const [ouvertes, setOuvertes] = useState<Set<string>>(() => new Set());
  const [confirmer, setConfirmer] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const connexion = getActiveConnection();
  const panneauRef = useRef<HTMLDivElement | null>(null);
  const vueRef = useRef(vue);
  vueRef.current = vue;

  const charger = useCallback(async () => {
    try {
      const r = await automatisationsApi.lister(connexion);
      setListe(Array.isArray(r?.automatisations) ? r.automatisations : []);
      setMaintenant(typeof r?.maintenantMs === "number" ? r.maintenantMs : Date.now());
      setErreur(null);
    } catch (e) {
      setErreur(messageErreur(e));
      setListe((l) => l ?? []);
    }
  }, [connexion]);

  // Liste relue à chaque changement annoncé par le service, et toutes les 30 s (dates relatives).
  useEffect(() => {
    void charger();
    let fin: (() => void) | undefined;
    let vivant = true;
    void agentsApi
      .onEvent((ev) => {
        if ((ev.event as string) === "automatisations") void charger();
      })
      .then((f) => (vivant ? (fin = f) : f()))
      .catch(() => undefined);
    const minuterie = window.setInterval(() => void charger(), 30_000);
    return () => {
      vivant = false;
      fin?.();
      window.clearInterval(minuterie);
    };
  }, [charger]);

  // Échap : retour à la liste, puis fermeture (dans un champ du formulaire : quitte d'abord le champ).
  useEffect(
    () =>
      fournirActions({
        stop: (e) => {
          const cible = e.target as HTMLElement | null;
          if (vueRef.current.genre === "formulaire" && cible?.matches?.("input, textarea, select")) {
            cible.blur();
            panneauRef.current?.focus();
            return;
          }
          if (vueRef.current.genre !== "liste") setVue({ genre: "liste" });
          else onFermer();
        },
      }),
    [onFermer],
  );

  // Focus dans l'écran à l'ouverture, rendu à l'élément d'avant à la fermeture.
  useEffect(() => {
    const avant = document.activeElement as HTMLElement | null;
    panneauRef.current?.focus();
    return () => avant?.focus?.();
  }, []);

  // Tab reste dans l'écran.
  const garderFocus = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panneauRef.current) return;
    const elements = [...panneauRef.current.querySelectorAll<HTMLElement>(FOCUSABLES)].filter((el) => el.offsetParent !== null);
    if (!elements.length) return;
    const premier = elements[0];
    const dernier = elements[elements.length - 1];
    if (e.shiftKey && (document.activeElement === premier || document.activeElement === panneauRef.current)) {
      e.preventDefault();
      dernier.focus();
    } else if (!e.shiftKey && document.activeElement === dernier) {
      e.preventDefault();
      premier.focus();
    }
  };

  const agir = async (id: string, action: () => Promise<unknown>) => {
    setOccupe(id);
    try {
      await action();
      setErreur(null);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setOccupe(null);
      void charger();
    }
  };

  const basculerHistorique = (id: string) =>
    setOuvertes((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const supprimer = (a: Automatisation) => {
    if (confirmer !== a.id) {
      setConfirmer(a.id);
      return;
    }
    setConfirmer(null);
    void agir(a.id, () => automatisationsApi.supprimer(a.id, connexion));
  };

  const voir = (a: Automatisation, x: Execution) => {
    if (!x.sessionId) return;
    setVue({ genre: "journal", sessionId: x.sessionId, titre: `${a.nom} · ${dateExecution(x, maintenant)}` });
  };


  const carte = (a: Automatisation) => {
    const derniere = a.historique.find((x) => x.statut !== "sautee" || a.historique.length === 1) ?? a.historique[0];
    const ouverte = ouvertes.has(a.id);
    const etat = a.enCours ? "en_cours" : a.active ? "active" : "pause";
    const bloque = occupe === a.id;
    return (
      <li key={a.id} className="auto-carte" data-etat={etat} data-id={a.id}>
        <div className="auto-carte__tete">
          <span className="auto-carte__point" aria-hidden="true" />
          <strong className="auto-carte__nom" title={a.nom}>{a.nom}</strong>
          <span className="auto-carte__horaire" title={a.horaireTexte}>{a.horaireTexte}</span>
        </div>
        <div className="auto-carte__infos">
          <span className="auto-carte__info" title={a.dossier}>{nomDossier(a.dossier)}</span>
          <span className="auto-carte__info" title={`${a.modele.provider}/${a.modele.name}`}>{a.modele.name}</span>
          <span className="auto-carte__info">{a.enCours ? "Exécution en cours" : prochaineTexte(a, maintenant)}</span>
          {derniere ? (
            <span className="auto-statut" data-statut={derniere.statut} title={derniere.resume ?? ""}>
              {STATUTS[derniere.statut]} · {dateExecution(derniere, maintenant)}
            </span>
          ) : null}
        </div>
        <div className="auto-carte__actions">
          {a.enCours ? (
            <button type="button" className="auto-btn" data-action="arreter" disabled={bloque} onClick={() => void agir(a.id, () => automatisationsApi.arreter(a.id, connexion))}>
              Arrêter
            </button>
          ) : (
            <button
              type="button"
              className="auto-btn"
              data-action="lancer"
              disabled={bloque}
              title="Lancer maintenant (sans la vérification avant lancement)"
              onClick={() => void agir(a.id, () => automatisationsApi.lancer(a.id, connexion))}
            >
              Lancer
            </button>
          )}
          <button
            type="button"
            className="auto-btn"
            data-action="pause"
            disabled={bloque}
            onClick={() => void agir(a.id, () => automatisationsApi.modifier(a.id, { active: !a.active }, connexion))}
          >
            {a.active ? "Pause" : "Reprendre"}
          </button>
          <button type="button" className="auto-btn" data-action="modifier" onClick={() => setVue({ genre: "formulaire", automatisation: a })}>
            Modifier
          </button>
          <button type="button" className="auto-btn" data-action="historique" aria-expanded={ouverte} onClick={() => basculerHistorique(a.id)}>
            {a.historique.length ? `Historique (${a.historique.length})` : "Historique"}
          </button>
          <button
            type="button"
            className="auto-btn auto-btn--danger"
            data-action="supprimer"
            data-confirm={confirmer === a.id ? "true" : undefined}
            disabled={bloque}
            onClick={() => supprimer(a)}
            onBlur={() => setConfirmer((c) => (c === a.id ? null : c))}
          >
            {confirmer === a.id ? "Supprimer ?" : "Supprimer"}
          </button>
        </div>
        {ouverte ? (
          a.historique.length ? (
            <ul className="auto-historique" aria-label={`Historique de ${a.nom}`}>
              {a.historique.map((x) => (
                <LigneExecution key={x.id} x={x} maintenant={maintenant} onVoir={(e) => voir(a, e)} />
              ))}
            </ul>
          ) : (
            <p className="auto-muet auto-historique__vide">Pas encore d'exécution.</p>
          )
        ) : null}
      </li>
    );
  };

  const triee = liste ? trier(liste) : [];
  let corps: JSX.Element;
  if (vue.genre === "formulaire") {
    corps = (
      <FormulaireAutomatisation
        initiale={vue.automatisation}
        dossierCourant={dossierCourant}
        connexion={connexion}
        onAnnuler={() => setVue({ genre: "liste" })}
        onEnregistree={() => {
          setVue({ genre: "liste" });
          void charger();
        }}
      />
    );
  } else if (vue.genre === "journal") {
    corps = (
      <div className="auto-journal">
        <SessionJournal sessionId={vue.sessionId} connectionId={connexion} title={vue.titre} onClose={() => setVue({ genre: "liste" })} />
      </div>
    );
  } else if (liste === null) {
    corps = <p className="auto-muet">Lecture des automatisations…</p>;
  } else if (!triee.length) {
    corps = (
      <div className="auto-vide">
        <p className="auto-vide__titre">Aucune automatisation.</p>
        <p className="auto-muet">
          Programmez un prompt sur un dossier : tous les jours à 8 h, chaque lundi, toutes les 2 heures… Le service le lance
          même quand l'appli est fermée, garde l'historique et prévient à la fin.
        </p>
        <button type="button" className="auto-btn auto-btn--primaire" onClick={() => setVue({ genre: "formulaire" })}>
          Créer une automatisation
        </button>
      </div>
    );
  } else {
    corps = <ul className="auto-liste">{triee.map(carte)}</ul>;
  }

  const titre = vue.genre === "formulaire" ? (vue.automatisation ? "Modifier l'automatisation" : "Nouvelle automatisation") : "Automatisations";
  // Un clic hors du panneau ferme la liste, jamais un formulaire en cours ni une conversation ouverte.
  return (
    <div className="auto-ecran" onMouseDown={(e) => e.target === e.currentTarget && vue.genre === "liste" && onFermer()}>
      <div
        className="auto-ecran__panneau"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auto-ecran-titre"
        tabIndex={-1}
        ref={panneauRef}
        onKeyDown={garderFocus}
      >
        <header className="auto-ecran__tete">
          {vue.genre !== "liste" ? (
            <button type="button" className="auto-btn" onClick={() => setVue({ genre: "liste" })} title="Retour à la liste (Échap)">
              ← Liste
            </button>
          ) : null}
          <h2 id="auto-ecran-titre" className="auto-ecran__titre" title={titre}>{titre}</h2>
          {vue.genre === "liste" && liste?.length ? <span className="auto-muet">{liste.length}</span> : null}
          <span className="auto-ecran__espace" />
          {vue.genre === "liste" ? (
            <button type="button" className="auto-btn auto-btn--primaire" onClick={() => setVue({ genre: "formulaire" })} title="Nouvelle automatisation">
              Nouvelle
            </button>
          ) : null}
          <button type="button" className="auto-btn auto-ecran__fermer" onClick={onFermer} aria-label="Fermer" title="Fermer (Échap)">
            ×
          </button>
        </header>
        {erreur && vue.genre === "liste" ? (
          <p className="auto-erreur" role="alert">
            {erreur}
          </p>
        ) : null}
        <div className="auto-ecran__corps" data-vue={vue.genre}>{corps}</div>
        {vue.genre === "liste" ? (
          <footer className="auto-ecran__pied auto-muet" title="Le service lance les automatisations même quand l'appli est fermée. PC éteint ou en veille : une exécution manquée est rattrapée au retour.">
            Lancées par le service, même appli fermée. PC en veille : une exécution rattrapée au retour.
          </footer>
        ) : null}
      </div>
    </div>
  );
}


// automatisations — création guidée : nom, dossier, prompt, horaire (en clair, avec les
// prochaines exécutions calculées par le service), modèle, conversation, vérification, rattrapage.
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { open as choisirDossier } from "@tauri-apps/plugin-dialog";
import { useModelChoices } from "../agents/useModelChoices";
import { LOCAL_CONNECTION } from "../settings/connectionsApi";
import { loadRecents } from "../../lib/recents";
import { automatisationsApi, type Apercu, type Automatisation, type Brouillon } from "./automatisationsApi";
import {
  GENRES,
  JOURS,
  basculerJour,
  brouillonDepuis,
  brouillonVide,
  champManquant,
  dateCourte,
  formeDepuisHoraire,
  horaireDepuisForme,
  messageErreur,
  type FormeHoraire,
  type GenreHoraire,
} from "./horaires";

type Props = {
  initiale?: Automatisation;
  dossierCourant?: string;
  connexion: string;
  onAnnuler: () => void;
  onEnregistree: (a: Automatisation) => void;
};

export function FormulaireAutomatisation({ initiale, dossierCourant, connexion, onAnnuler, onEnregistree }: Props) {
  const choix = useModelChoices();
  const [b, setB] = useState<Brouillon>(() => (initiale ? brouillonDepuis(initiale) : brouillonVide(dossierCourant ?? "")));
  const [forme, setForme] = useState<FormeHoraire>(() => formeDepuisHoraire(initiale?.horaire));
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [erreurApercu, setErreurApercu] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const nomRef = useRef<HTMLInputElement | null>(null);
  const recents = useMemo(() => loadRecents().slice(0, 12), []);
  const horaire = useMemo(() => horaireDepuisForme(forme), [forme]);
  const maj = <K extends keyof Brouillon>(cle: K, valeur: Brouillon[K]) => setB((x) => ({ ...x, [cle]: valeur }));

  useEffect(() => nomRef.current?.focus(), []);

  // Modèle par défaut : le premier modèle disponible.
  useEffect(() => {
    if (!b.modele && choix.length) setB((x) => (x.modele ? x : { ...x, modele: choix[0].value }));
  }, [choix, b.modele]);

  // Horaire en clair et prochaines exécutions, calculés par le service (fuseau du poste).
  useEffect(() => {
    let vivant = true;
    const minuterie = window.setTimeout(() => {
      automatisationsApi
        .apercu(horaire, connexion)
        .then((r) => {
          if (!vivant) return;
          setApercu(r);
          setErreurApercu(null);
        })
        .catch((e) => {
          if (!vivant) return;
          setApercu(null);
          setErreurApercu(messageErreur(e));
        });
    }, 250);
    return () => {
      vivant = false;
      window.clearTimeout(minuterie);
    };
  }, [horaire, connexion]);

  const parcourir = async () => {
    try {
      const choisi = await choisirDossier({ directory: true, multiple: false, title: "Dossier de l'automatisation" });
      if (typeof choisi === "string" && choisi) maj("dossier", choisi);
    } catch {
      /* sélecteur fermé */
    }
  };

  const envoyer = async (e: FormEvent) => {
    e.preventDefault();
    const brouillon: Brouillon = { ...b, horaire };
    const manque = champManquant(brouillon);
    if (manque) {
      setErreur(manque);
      return;
    }
    setEnvoi(true);
    setErreur(null);
    try {
      const a = initiale
        ? await automatisationsApi.modifier(initiale.id, brouillon, connexion)
        : await automatisationsApi.creer(brouillon, connexion);
      onEnregistree(a);
    } catch (err) {
      setErreur(messageErreur(err));
    } finally {
      setEnvoi(false);
    }
  };

  const modeleInconnu = b.modele && !choix.some((c) => c.value === b.modele);


  return (
    <form className="auto-form" onSubmit={(e) => void envoyer(e)} noValidate>
      <div className="auto-form__champs">
        <label className="auto-champ">
          <span className="auto-champ__libelle">Nom</span>
          <input
            ref={nomRef}
            value={b.nom}
            maxLength={120}
            placeholder="Rapport du matin"
            onChange={(e) => maj("nom", e.target.value)}
          />
        </label>
        <div className="auto-champ">
          <label className="auto-champ__libelle" htmlFor="auto-dossier">Dossier</label>
          <div className="auto-champ__ligne">
            <input
              id="auto-dossier"
              value={b.dossier}
              list="auto-dossiers-recents"
              placeholder="Chemin du dossier"
              title={b.dossier}
              onChange={(e) => maj("dossier", e.target.value)}
            />
            {connexion === LOCAL_CONNECTION ? (
              <button type="button" className="auto-btn" onClick={() => void parcourir()}>
                Parcourir…
              </button>
            ) : null}
          </div>
          <datalist id="auto-dossiers-recents">
            {recents.map((r) => (
              <option key={r.path} value={r.path}>
                {r.name}
              </option>
            ))}
          </datalist>
        </div>
        <label className="auto-champ">
          <span className="auto-champ__libelle">Prompt</span>
          <textarea
            value={b.prompt}
            rows={5}
            placeholder="Fais le point sur les tickets ouverts et résume ce qui a changé depuis hier."
            onChange={(e) => maj("prompt", e.target.value)}
          />
        </label>
        <fieldset className="auto-champ auto-horaire">
          <legend className="auto-champ__libelle">Quand</legend>
          <div className="auto-champ__ligne">
            <select
              aria-label="Type d'horaire"
              value={forme.genre}
              onChange={(e) => setForme((f) => ({ ...f, genre: e.target.value as GenreHoraire }))}
            >
              {GENRES.map((g) => (
                <option key={g.valeur} value={g.valeur}>
                  {g.libelle}
                </option>
              ))}
            </select>
            {forme.genre === "quotidien" || forme.genre === "hebdomadaire" ? (
              <input
                type="time"
                aria-label="Heure"
                className="auto-horaire__heure"
                value={forme.heure}
                onChange={(e) => setForme((f) => ({ ...f, heure: e.target.value }))}
              />
            ) : null}
            {forme.genre === "intervalle" ? (
              <label className="auto-horaire__intervalle">
                <span>toutes les</span>
                <input
                  type="number"
                  min={1}
                  max={24}
                  aria-label="Nombre d'heures"
                  value={forme.heures}
                  onChange={(e) => setForme((f) => ({ ...f, heures: Math.max(1, Math.min(24, Number(e.target.value) || 1)) }))}
                />
                <span>heures</span>
              </label>
            ) : null}
            {forme.genre === "cron" ? (
              <input
                aria-label="Expression cron"
                className="auto-horaire__cron"
                value={forme.expression}
                placeholder="0 8 * * 1-5"
                title="minute heure jour mois jour-de-semaine"
                onChange={(e) => setForme((f) => ({ ...f, expression: e.target.value }))}
              />
            ) : null}
          </div>
          {forme.genre === "hebdomadaire" ? (
            <div className="auto-jours" role="group" aria-label="Jours de la semaine">
              {JOURS.map((j) => (
                <button
                  key={j.valeur}
                  type="button"
                  className="auto-jour"
                  aria-pressed={forme.jours.includes(j.valeur)}
                  aria-label={j.nom}
                  title={j.nom}
                  onClick={() => setForme((f) => ({ ...f, jours: basculerJour(f.jours, j.valeur) }))}
                >
                  {j.court}
                </button>
              ))}
            </div>
          ) : null}
          <p className="auto-apercu" data-erreur={erreurApercu ? "true" : undefined} aria-live="polite">
            {erreurApercu
              ? erreurApercu
              : apercu
                ? `${apercu.texte}${apercu.prochaines.length ? ` · prochaine : ${dateCourte(apercu.prochaines[0])}` : ""}`
                : "…"}
          </p>
        </fieldset>
        <label className="auto-champ">
          <span className="auto-champ__libelle">Modèle</span>
          <select value={b.modele} onChange={(e) => maj("modele", e.target.value)}>
            {modeleInconnu ? <option value={b.modele}>{b.modele}</option> : null}
            {/* Pas de paragraphe sous le champ : il apparaissait puis disparaissait pendant la lecture des modèles. */}
            {!b.modele ? <option value="">{choix.length ? "Choisir un modèle" : "Aucun modèle (connectez un fournisseur dans les Réglages)"}</option> : null}
            {choix.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="auto-champ">
          <legend className="auto-champ__libelle">Conversation</legend>
          <label className="auto-choix">
            <input type="radio" name="auto-conversation" checked={!b.memeConversation} onChange={() => maj("memeConversation", false)} />
            <span title="Une nouvelle conversation à chaque exécution">Une nouvelle à chaque exécution</span>
          </label>
          <label className="auto-choix">
            <input type="radio" name="auto-conversation" checked={b.memeConversation} onChange={() => maj("memeConversation", true)} />
            <span title="Toujours la même conversation">Toujours la même</span>
          </label>
        </fieldset>
        <label className="auto-champ">
          <span className="auto-champ__libelle">Vérification avant lancement (facultative)</span>
          <input
            value={b.verification}
            placeholder="par ex. git pull --ff-only"
            spellCheck={false}
            onChange={(e) => maj("verification", e.target.value)}
          />
          <span className="auto-muet">Commande lancée dans le dossier : code 0 = on lance, sinon l'exécution est sautée.</span>
        </label>
        <label className="auto-choix">
          <input type="checkbox" data-champ="rattrapage" checked={b.rattrapage} onChange={(e) => maj("rattrapage", e.target.checked)} />
          <span title="Après une veille ou un arrêt du PC, une seule exécution manquée est relancée.">Rattraper une exécution manquée (PC en veille ou éteint)</span>
        </label>
        <label className="auto-choix">
          <input type="checkbox" data-champ="active" checked={b.active} onChange={(e) => maj("active", e.target.checked)} />
          <span>Active</span>
        </label>
      </div>
      <div className="auto-form__actions">
        {erreur ? (
          <p className="auto-erreur" role="alert">
            {erreur}
          </p>
        ) : null}
        <button type="button" className="auto-btn" onClick={onAnnuler}>
          Annuler
        </button>
        <button type="submit" className="auto-btn auto-btn--primaire" disabled={envoi}>
          {initiale ? "Enregistrer" : "Créer"}
        </button>
      </div>
    </form>
  );
}


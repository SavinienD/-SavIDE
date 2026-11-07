import { lireMesure } from "./direct";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import {
  ecrireReglagesVoix,
  EVENEMENT_REGLAGES_VOIX,
  lireReglagesVoix,
  type ReglagesVoix,
} from "./reglages";
import { dicteeDisponible, MESSAGE_DICTEE_INDISPONIBLE_LOCAL } from "./disponibilite"; // 0.1.71
import { lireEtatVoix } from "./useDicteeDisponible";
import { combinaisonCourte } from "../raccourcis";
import {
  avecActif,
  chargerVocabulaire,
  enregistrerVocabulaire,
  EVENEMENT_VOCABULAIRE,
  LIMITE_VOCABULAIRE,
  motsAppris,
  retirer,
  toutEffacer,
  vocabulaireEffectif,
  type EtatVocabulaire,
} from "./vocabulaireAuto"; // voix-vocabulaire
import "./voix.css";
import { listen } from "@tauri-apps/api/event";

const MODELES_LOCAUX = [
  { nom: "base" as const, libelle: "Petit (base)", taille: "148 Mo", aide: "Rapide, bon pour des phrases courtes." },
  { nom: "small" as const, libelle: "Moyen (small)", taille: "488 Mo", aide: "Plus précis, environ trois fois plus lent." },
];

/** voix — Réglages > Dictée vocale : options et test des moteurs. */
type Moteur = { url: string; label: string; ok: boolean; error?: string | null };
type EtatService = { connexion: string; ok: boolean; moteurs?: Moteur[] | null; erreur?: string };
type ModeleLocal = { nom: string; octets: number; present: boolean };
type EtatVoix = { services: EtatService[]; openai: boolean; local?: { ok: boolean; modeles?: ModeleLocal[] } | null };

export function VoixSection({ workspacePath }: { workspacePath?: string }) {
  const [reglages, setReglages] = useState<ReglagesVoix>(() => lireReglagesVoix());
  const [etat, setEtat] = useState<EtatVoix | null>(null);
  const [test, setTest] = useState<"repos" | "en-cours" | "erreur">("repos");
  const [erreurTest, setErreurTest] = useState("");
  const [dispo, setDispo] = useState<boolean | null>(null);
  const [mesure] = useState(() => lireMesure()); // 0.1.75
  useEffect(() => {
    let fini = false;
    void lireEtatVoix(workspacePath).then((e) => {
      if (!fini) setDispo(dicteeDisponible(e, { localSeulement: true }));
    });
    return () => {
      fini = true;
    };
  }, [workspacePath]);

  useEffect(() => {
    const relire = () => setReglages(lireReglagesVoix());
    window.addEventListener(EVENEMENT_REGLAGES_VOIX, relire);
    return () => window.removeEventListener(EVENEMENT_REGLAGES_VOIX, relire);
  }, []);

  // voix-vocabulaire — mots appris des messages tapés (voir vocabulaireAuto.ts).
  const [vocab, setVocab] = useState<EtatVocabulaire>(() => chargerVocabulaire());
  useEffect(() => {
    const relire = () => setVocab(chargerVocabulaire());
    window.addEventListener(EVENEMENT_VOCABULAIRE, relire);
    return () => window.removeEventListener(EVENEMENT_VOCABULAIRE, relire);
  }, []);
  const changerVocab = (suivant: EtatVocabulaire) => {
    setVocab(suivant);
    enregistrerVocabulaire(suivant);
  };
  const appris = motsAppris(vocab);
  const envoye = vocabulaireEffectif(reglages.vocabulaire, vocab);
  const envoyes = new Set(envoye.split(", ").map((t) => t.toLowerCase()));

  const changer = (patch: Partial<ReglagesVoix>) => {
    const suivant = { ...reglages, ...patch };
    setReglages(suivant);
    ecrireReglagesVoix(suivant);
  };

  // micro-local — téléchargement du modèle choisi, avec progression.
  const [telechargement, setTelechargement] = useState<string | null>(null);
  useEffect(() => {
    void tester();
    let stop: (() => void) | undefined;
    void listen<{ recu: number; total: number }>("axe://voix-modele", (e) => {
      const p = e.payload;
      if (p?.total) setTelechargement(`Téléchargement… ${Math.floor((100 * p.recu) / p.total)} %`);
    }).then((f) => (stop = f));
    return () => stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const telecharger = async () => {
    setTelechargement("Téléchargement…");
    setErreurTest("");
    try {
      const local = await invoke<EtatVoix["local"]>("voix_modele_local", { input: { modele: reglages.modeleLocal === "auto" ? "small" : reglages.modeleLocal } });
      setEtat((e) => (e ? { ...e, local } : e));
    } catch (err) {
      setErreurTest(String(err));
    } finally {
      setTelechargement(null);
    }
  };

  const tester = async () => {
    setTest("en-cours");
    setErreurTest("");
    try {
      const lu = await invoke<EtatVoix>("voix_etat", { input: { workspacePath: workspacePath ?? null } });
      setEtat(lu);
      setDispo(dicteeDisponible(lu, { localSeulement: true }));
      void lireEtatVoix(workspacePath, true);
      setTest("repos");
    } catch (err) {
      setErreurTest(String(err));
      setTest("erreur");
    }
  };

  // 0.1.71 — SavIDE (100 % local) : sans moteur Whisper sur le poste, la dictée est masquée.
  if (dispo === false) {
    return (
      <div className="axe-appearance axe-voix-reglages">
        <header>
          <h2>Dictée vocale</h2>
        </header>
        <p className="axe-voix-reglages__ko" role="status">{MESSAGE_DICTEE_INDISPONIBLE_LOCAL}</p>
        <button type="button" className="axe-appearance__button" title="Revérifier" onClick={() => void tester()} disabled={test === "en-cours"}>
          {test === "en-cours" ? "Test…" : "Revérifier"}
        </button>
      </div>
    );
  }

  return (
    <div className="axe-appearance axe-voix-reglages">
      <header>
        <h2 title="Dictée vocale">Dictée vocale</h2>
        <p className="axe-appearance__hint">
          Micro du compositeur ({combinaisonCourte("dictee")}) : enregistrement, puis transcription par Whisper sur ce poste (français, vocabulaire technique), nettoyée ensuite par le modèle de la conversation. Le texte est inséré dans la
          zone de saisie, modifiable, et n'est jamais envoyé automatiquement. Échap annule.
        </p>
      </header>

      <section className="axe-appearance__block">
        <h3>Options</h3>
        <label className="axe-voix-reglages__ligne">
          <input
            type="checkbox"
            checked={reglages.nettoyer}
            onChange={(e) => changer({ nettoyer: e.target.checked })}
          />
          <span>
            Nettoyer le texte avec l'IA
            <br />
            <span className="axe-appearance__hint">
              Ponctuation et termes techniques corrigés par le modèle du chat (quelques secondes et
              quelques jetons de plus). Sans reformulation. Désactivé par défaut.
            </span>
          </span>
        </label>
      </section>

      <section className="axe-appearance__block" data-testid="voix-modele-local">
        <h3>Modèle</h3>
        <p className="axe-appearance__hint">
          Transcription 100&nbsp;% sur ce poste (whisper.cpp intégré)&nbsp;: l'audio ne quitte jamais
          l'ordinateur. Le modèle est téléchargé une fois, au premier usage, puis vérifié
          (empreinte SHA-256).
        </p>
        <label className="axe-voix-reglages__ligne">
          <input
            type="checkbox"
            checked={reglages.direct}
            onChange={(e) => changer({ direct: e.target.checked })}
          />
          <span>
            Transcription en direct
            <br />
            <span className="axe-appearance__hint">
              Morceaux d'environ 3 s transcrits pendant que vous parlez (texte provisoire grisé),
              remplacés à la fin par la transcription complète.
            </span>
          </span>
        </label>
        <label className="axe-voix-reglages__ligne">
          <input
            type="radio"
            name="axe-voix-modele"
            checked={reglages.modeleLocal === "auto"}
            onChange={() => changer({ modeleLocal: "auto" })}
          />
          <span>
            Automatique
            <br />
            <span className="axe-appearance__hint">
              Moyen s'il transcrit en moins de 2× la durée parlée sur ce poste (mesuré pendant les
              dictées), sinon petit. Le moyen est téléchargé en arrière-plan à la première dictée.
              {mesure ? ` Dernière mesure : moyen à ${String(mesure.facteur).replace(".", ",")}× le temps réel, ${mesure.taille} retenu.` : ""}
            </span>
          </span>
        </label>
        {MODELES_LOCAUX.map((m) => {
          const present = etat?.local?.modeles?.find((x) => x.nom === m.nom)?.present;
          return (
            <label key={m.nom} className="axe-voix-reglages__ligne">
              <input
                type="radio"
                name="axe-voix-modele"
                checked={reglages.modeleLocal === m.nom}
                onChange={() => changer({ modeleLocal: m.nom })}
              />
              <span>
                {m.libelle}
                <br />
                <span className="axe-appearance__hint">
                  {m.aide}
                  {present === true ? " Déjà téléchargé." : present === false ? ` Téléchargement de ${m.taille} au premier usage.` : ""}
                </span>
              </span>
            </label>
          );
        })}
        <button
          type="button"
          className="axe-appearance__button"
          onClick={() => void telecharger()}
          disabled={telechargement !== null}
        >
          {telechargement ?? "Télécharger maintenant"}
        </button>
        {erreurTest && <p className="axe-voix-reglages__ko">{erreurTest}</p>}
      </section>

      <section className="axe-appearance__block">
        <h3>Vocabulaire</h3>
        <p className="axe-appearance__hint">
          Déjà connus : SavIDE, VM, Caddy, Forgejo, Tauri, Jira, WhatsApp,
          sous-agent, harness, worktree, commit, push, installeur. Ajoutez vos termes, séparés par
          des virgules (noms de clients, d'outils…).
        </p>
        <textarea
          value={reglages.vocabulaire}
          placeholder="ex. Grafana, Kubernetes, Dupont SA"
          onChange={(e) => changer({ vocabulaire: e.target.value.slice(0, 400) })}
        />
      </section>

      <section className="axe-appearance__block axe-voix-appris">
        <h3 title="Mots appris de vos messages">Mots appris</h3>
        <label className="axe-voix-reglages__ligne">
          <input
            type="checkbox"
            checked={vocab.actif}
            onChange={(e) => changerVocab(avecActif(vocab, e.target.checked))}
          />
          <span>
            Apprendre les mots que je tape
            <br />
            <span className="axe-appearance__hint">
              Noms propres, sigles et termes techniques vus dans au moins deux de vos messages,
              ajoutés au vocabulaire de la dictée. Gardés sur ce poste. Jamais de mot de passe, de
              clé, de jeton ni de lien.
            </span>
          </span>
        </label>
        {vocab.actif && (
          <>
            <div className="axe-voix-appris__tete">
              <p className="axe-appearance__hint axe-voix-appris__compte">
                {appris.length === 0
                  ? "Aucun mot appris pour l'instant."
                  : `${appris.length} mot${appris.length > 1 ? "s" : ""} appris · vocabulaire envoyé : ${envoye.length}/${LIMITE_VOCABULAIRE} caractères`}
              </p>
              {appris.length > 0 && (
                <button type="button" className="axe-appearance__button axe-voix-appris__effacer" title="Oublier tous les mots appris" onClick={() => changerVocab(toutEffacer(vocab))}>
                  Tout effacer
                </button>
              )}
            </div>
            {appris.length > 0 && (
              <ul className="axe-voix-appris__liste" aria-label="Mots appris">
                {appris.map((mot) => (
                  <li key={mot.cle} className="axe-voix-appris__mot" data-mot={mot.cle} data-envoye={envoyes.has(mot.cle) ? "true" : "false"}>
                    <span title={`Vu dans ${mot.n} messages`}>{mot.forme}</span>
                    <button
                      type="button"
                      className="axe-voix-appris__retirer"
                      aria-label={`Retirer ${mot.forme}`}
                      title="Retirer (ne sera plus appris)"
                      onClick={() => changerVocab(retirer(vocab, mot.cle))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

    </div>
  );
}

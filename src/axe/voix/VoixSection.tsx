import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

import {
  ecrireReglagesVoix,
  EVENEMENT_REGLAGES_VOIX,
  lireReglagesVoix,
  type ReglagesVoix,
} from "./reglages";
import { dicteeDisponible, MESSAGE_DICTEE_INDISPONIBLE } from "./disponibilite"; // axe:0.1.71
import { lireEtatVoix } from "./useDicteeDisponible";
import "./voix.css";

/** axe:voix — Réglages > Dictée vocale : options et test des moteurs. */
type Moteur = { url: string; label: string; ok: boolean; error?: string | null };
type EtatService = { connexion: string; ok: boolean; moteurs?: Moteur[] | null; erreur?: string };
type EtatVoix = { services: EtatService[]; openai: boolean };

export function VoixSection({ workspacePath }: { workspacePath?: string }) {
  const [reglages, setReglages] = useState<ReglagesVoix>(() => lireReglagesVoix());
  const [etat, setEtat] = useState<EtatVoix | null>(null);
  const [test, setTest] = useState<"repos" | "en-cours" | "erreur">("repos");
  const [erreurTest, setErreurTest] = useState("");
  const [dispo, setDispo] = useState<boolean | null>(null);
  useEffect(() => {
    let fini = false;
    void lireEtatVoix(workspacePath).then((e) => {
      if (!fini) setDispo(dicteeDisponible(e));
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

  const changer = (patch: Partial<ReglagesVoix>) => {
    const suivant = { ...reglages, ...patch };
    setReglages(suivant);
    ecrireReglagesVoix(suivant);
  };

  const tester = async () => {
    setTest("en-cours");
    setErreurTest("");
    try {
      const lu = await invoke<EtatVoix>("voix_etat", { input: { workspacePath: workspacePath ?? null } });
      setEtat(lu);
      setDispo(dicteeDisponible(lu));
      void lireEtatVoix(workspacePath, true);
      setTest("repos");
    } catch (err) {
      setErreurTest(String(err));
      setTest("erreur");
    }
  };

  return (
    <div className="axe-appearance axe-voix-reglages">
      <header>
        <h2>Dictée vocale</h2>
        <p className="axe-appearance__hint">
          Micro du compositeur (Ctrl+Maj+D) : enregistrement, puis transcription par Whisper
          large-v3-turbo sur la VM (français, vocabulaire technique). Le texte est inséré dans la
          zone de saisie, modifiable, et n'est jamais envoyé automatiquement. Échap annule.
        </p>
      </header>
      {dispo === false && (
        <p className="axe-voix-reglages__ko" role="status">
          {MESSAGE_DICTEE_INDISPONIBLE} Lancez « Tester les moteurs » une fois un moteur démarré.
        </p>
      )}

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
        <label className="axe-voix-reglages__ligne">
          <input
            type="checkbox"
            checked={reglages.repliOpenai}
            onChange={(e) => changer({ repliOpenai: e.target.checked })}
          />
          <span>
            Repli OpenAI si la VM est injoignable
            <br />
            <span className="axe-appearance__hint">
              gpt-4o-transcribe puis whisper-1, seulement si une clé API OpenAI est configurée
              (fournisseur « compatible OpenAI » sur api.openai.com, ou OPENAI_API_KEY). L'audio part
              alors chez OpenAI.
            </span>
          </span>
        </label>
      </section>

      <section className="axe-appearance__block">
        <label className="axe-voix-reglages__ligne">
          <input
            type="checkbox"
            checked={reglages.rapide}
            onChange={(e) => changer({ rapide: e.target.checked })}
          />
          <span>
            Dictée rapide (moins précise)
            <br />
            <span className="axe-appearance__hint">
              Whisper n'analyse que la durée parlée au lieu d'une fenêtre de 30 s : environ 6 s au
              lieu de 17 s pour une phrase courte, mais des erreurs nettement plus fréquentes
              (mesuré). Désactivé par défaut.
            </span>
          </span>
        </label>
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

      <section className="axe-appearance__block">
        <h3>Moteurs</h3>
        <p className="axe-appearance__hint">
          Ordre : service de l'espace cloud (Whisper de la VM), puis OpenAI (si clé), sinon dictée
          Windows (Win+H) proposée en secours.
        </p>
        <button type="button" className="axe-appearance__button" onClick={() => void tester()} disabled={test === "en-cours"}>
          {test === "en-cours" ? "Test…" : "Tester les moteurs"}
        </button>
        {test === "erreur" && <p className="axe-voix-reglages__ko">{erreurTest}</p>}
        {etat && (
          <div className="axe-voix-reglages__etat">
            {etat.services.map((service) => (
              <div key={service.connexion}>
                <strong>{service.connexion}</strong>
                {service.ok ? (
                  (service.moteurs ?? []).map((m) => (
                    <div key={m.url} className={m.ok ? "axe-voix-reglages__ok" : "axe-voix-reglages__ko"}>
                      {m.ok ? "✓" : "✗"} {m.label}
                      {m.ok ? "" : ` — ${m.error ?? "injoignable"}`}
                    </div>
                  ))
                ) : (
                  <div className="axe-voix-reglages__ko">✗ {service.erreur}</div>
                )}
              </div>
            ))}
            <div className={etat.openai ? "axe-voix-reglages__ok" : ""}>
              {etat.openai ? "✓ clé OpenAI configurée" : "– pas de clé OpenAI (repli indisponible)"}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

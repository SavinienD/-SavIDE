import { useEffect, useState } from "react";

import { formaterDuree } from "./inserer";
import { useDictee } from "./useDictee";
import { useDicteeDisponible } from "./useDicteeDisponible"; // axe:0.1.71
import "./voix.css";

/**
 * axe:voix — bouton micro du compositeur, « comme le message vocal de ChatGPT » :
 * clic -> enregistrement (onde, minuteur, ✕ annuler, ✓ terminer) -> transcription
 * Whisper sur la VM -> texte inséré dans la zone de saisie, modifiable, JAMAIS envoyé.
 * Le ✓ garde aria-label « Dicter » : le raccourci Ctrl+Maj+D (Workspace.tsx) démarre
 * puis termine la dictée.
 */
type Props = {
  workspacePath?: string;
  modele?: { provider: string; name: string } | null;
  onTexte: (texte: string) => void;
};

function IconeMicro() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </svg>
  );
}

function IconeCroix() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function IconeValider() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Chrono({ depuis }: { depuis: number }) {
  const [maintenant, setMaintenant] = useState(() => performance.now());
  useEffect(() => {
    const minuterie = window.setInterval(() => setMaintenant(performance.now()), 500);
    return () => window.clearInterval(minuterie);
  }, []);
  return <span className="axe-voix__temps">{formaterDuree(maintenant - depuis)}</span>;
}

export function DicteeBouton({ workspacePath, modele, onTexte }: Props) {
  const d = useDictee({ workspacePath, modele, onTexte });
  // axe:0.1.71 — sans moteur qui répond, pas de micro (au lieu de l'erreur « connexion refusée »).
  const dispo = useDicteeDisponible(workspacePath);
  const enregistre = d.phase === "enregistrement" || d.phase === "demarrage";
  if (dispo !== true) return null;

  return (
    <span className="axe-voix">
      <button
        type="button"
        className="composer__iconbtn axe-voix__micro"
        aria-label="Dicter"
        title="Dicter (Ctrl+Maj+D) : transcription Whisper sur la VM, texte modifiable avant envoi"
        data-actif={d.phase === "repos" || d.phase === "erreur" ? "false" : "true"}
        onClick={() => void d.demarrer()}
        tabIndex={enregistre || d.phase === "transcription" ? -1 : 0}
      >
        <IconeMicro />
      </button>

      {enregistre && (
        <span className="axe-voix__barre" role="group" aria-label="Dictée en cours">
          <button
            type="button"
            className="axe-voix__rond axe-voix__annuler"
            aria-label="Annuler la dictée"
            title="Annuler (Échap)"
            onClick={d.annuler}
          >
            <IconeCroix />
          </button>
          <span className="axe-voix__point" data-pret={d.phase === "enregistrement" ? "true" : "false"} aria-hidden="true" />
          <span className="axe-voix__onde" aria-hidden="true">
            {d.niveaux.map((niveau, i) => (
              <i key={i} style={{ transform: `scaleY(${Math.max(0.08, niveau).toFixed(3)})` }} />
            ))}
          </span>
          <span className="axe-voix__temps">{d.phase === "demarrage" ? "micro…" : formaterDuree(d.dureeMs)}</span>
          <button
            type="button"
            className="axe-voix__rond axe-voix__valider"
            aria-label="Dicter"
            title="Terminer et transcrire (Ctrl+Maj+D)"
            disabled={d.phase !== "enregistrement"}
            onClick={() => void d.terminer()}
          >
            <IconeValider />
          </button>
        </span>
      )}

      {d.phase === "transcription" && (
        <span className="axe-voix__barre axe-voix__barre--attente" role="status" aria-live="polite">
          <span className="axe-voix__roue" aria-hidden="true" />
          <span className="axe-voix__libelle">Transcription…</span>
          <Chrono depuis={d.debutTranscription || performance.now()} />
          <button
            type="button"
            className="axe-voix__rond axe-voix__annuler"
            aria-label="Annuler la transcription"
            title="Annuler (Échap)"
            onClick={d.annuler}
          >
            <IconeCroix />
          </button>
        </span>
      )}

      {d.phase === "erreur" && d.erreur && (
        <span className="axe-voix__bulle" role="alert">
          <span className="axe-voix__bulle-texte">{d.erreur.message}</span>
          <span className="axe-voix__bulle-actions">
            {d.erreur.winH && (
              <button type="button" onClick={d.dicteeWindows}>
                Dictée Windows (Win+H)
              </button>
            )}
            <button type="button" onClick={() => void d.demarrer()}>
              Réessayer
            </button>
            <button type="button" onClick={d.fermer}>
              Fermer
            </button>
          </span>
        </span>
      )}

      {d.phase === "repos" && d.info && (
        <span className="axe-voix__bulle axe-voix__bulle--info" role="status" onClick={d.fermer}>
          {d.info}
        </span>
      )}
    </span>
  );
}

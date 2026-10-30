import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

/** axe:0.1.75 — seule la fin du texte provisoire est montrée (pas de texte coupé par un cadre). */
export function finProvisoire(texte: string, max = 200): string {
  if (texte.length <= max) return texte;
  const fin = texte.slice(-max);
  const espace = fin.indexOf(" ");
  return "…" + (espace > 0 && espace < 40 ? fin.slice(espace + 1) : fin);
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
  // SavIDE est 100 % local : seul un moteur Whisper du poste compte (jamais celui de la VM).
  const dispo = useDicteeDisponible(workspacePath, { localSeulement: true });
  const enregistre = d.phase === "enregistrement" || d.phase === "demarrage";
  // axe:0.1.71 — barre d'enregistrement et bulles placées dans la rangée d'actions et dans la
  // boîte du compositeur (portails), plus sous le micro : ancrées au micro, elles dépassaient
  // de la colonne étroite (bulle « … en 6,0 s, » rognée, coupée à droite, sur le compositeur).
  const ancre = useRef<HTMLSpanElement | null>(null);
  const [cibles, setCibles] = useState<{ rangee: HTMLElement | null; boite: HTMLElement | null }>({ rangee: null, boite: null });
  useLayoutEffect(() => {
    const el = ancre.current;
    const rangee = el?.closest<HTMLElement>(".composer__actions") ?? null;
    const boite = el?.closest<HTMLElement>(".composer__box") ?? null;
    if (rangee !== cibles.rangee || boite !== cibles.boite) setCibles({ rangee, boite });
  });
  const placer = (noeud: ReactNode, cible: HTMLElement | null) => (cible ? createPortal(noeud, cible) : noeud);
  if (dispo !== true) return null;

  return (
    <span className="axe-voix" ref={ancre}>
      <button
        type="button"
        className="composer__iconbtn axe-voix__micro"
        aria-label="Dicter"
        title="Dicter (Ctrl+Maj+D) : transcription Whisper gratuite (VM ou poste), en direct, texte modifiable avant envoi"
        data-actif={d.phase === "repos" || d.phase === "erreur" ? "false" : "true"}
        onClick={() => void d.demarrer()}
        tabIndex={enregistre || d.phase === "transcription" ? -1 : 0}
      >
        <IconeMicro />
      </button>

      {enregistre && placer(
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
        </span>,
        cibles.rangee,
      )}

      {d.phase === "transcription" && placer(
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
        </span>,
        cibles.rangee,
      )}

      {(enregistre || d.phase === "transcription") && (d.provisoire || (enregistre && (d.direct.actif || d.direct.erreur))) && placer(
        // axe:0.1.75 — texte provisoire de la dictée en direct, grisé ; le texte final le remplace.
        <span className="axe-voix__provisoire" role="status" aria-live="polite" title="Texte provisoire : remplacé par la transcription complète à la fin">
          {/* axe:0.1.77 — encadré visible dès le début du direct (attente), avec la raison d'un aperçu absent. */}
          {d.provisoire ? (
            <span className="axe-voix__provisoire-texte">{finProvisoire(d.provisoire)}<span aria-hidden="true">…</span></span>
          ) : d.direct.erreur ? (
            <span className="axe-voix__provisoire-texte" data-etat="erreur">Aperçu en direct indisponible : {d.direct.erreur}</span>
          ) : (
            <span className="axe-voix__provisoire-texte" data-etat="attente">En direct : le texte s'affiche ici au fil de la parole…</span>
          )}
        </span>,
        cibles.boite,
      )}

      {d.phase === "erreur" && d.erreur && placer(
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
        </span>,
        cibles.boite,
      )}

      {d.phase === "repos" && d.info && placer(
        <span className="axe-voix__bulle axe-voix__bulle--info" role="status" onClick={d.fermer}>
          {d.info}
        </span>,
        cibles.boite,
      )}
    </span>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  blobEnBase64,
  classerErreurMicro,
  EnregistreurVoix,
  messageErreurMicro,
  microDisponible,
} from "./enregistreur";
import { lireReglagesVoix } from "./reglages";

/** axe:voix — machine à états de la dictée : repos -> enregistrement ->
 *  transcription -> texte inséré (jamais envoyé), ou erreur avec secours Win+H. */
export type PhaseDictee = "repos" | "demarrage" | "enregistrement" | "transcription" | "erreur";

export type ResultatTranscription = {
  text: string;
  brut?: string;
  nettoye?: boolean;
  moteur?: string | null;
  engine?: string | null;
  transcriptionMs?: number | null;
  ms?: number;
  echecs?: string[];
  avertissements?: string[];
};

export const NB_BARRES = 28;
/** Au-delà, la dictée est terminée d'office (et transcrite). */
export const DUREE_MAX_MS = 10 * 60 * 1000;
const ANNULE = "dictée annulée";

type Options = {
  workspacePath?: string;
  modele?: { provider: string; name: string } | null;
  onTexte: (texte: string) => void;
};

function nouvelleDemande(): string {
  return `voix-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function texteErreur(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function useDictee({ workspacePath, modele, onTexte }: Options) {
  const [phase, setPhase] = useState<PhaseDictee>("repos");
  const [niveaux, setNiveaux] = useState<number[]>(() => Array(NB_BARRES).fill(0));
  const [dureeMs, setDureeMs] = useState(0);
  const [erreur, setErreur] = useState<{ message: string; winH: boolean } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const enregistreur = useRef<EnregistreurVoix | null>(null);
  const demandeCourante = useRef<string | null>(null);
  const debutTranscription = useRef(0);
  const animation = useRef<number | null>(null);
  const onTexteRef = useRef(onTexte);
  onTexteRef.current = onTexte;
  const contexteRef = useRef({ workspacePath, modele });
  contexteRef.current = { workspacePath, modele };
  const terminerRef = useRef<() => void>(() => undefined);

  const arreterAnimation = useCallback(() => {
    if (animation.current !== null) window.cancelAnimationFrame(animation.current);
    animation.current = null;
  }, []);

  const animer = useCallback(() => {
    let dernier = 0;
    const tick = (maintenant: number) => {
      const enr = enregistreur.current;
      if (!enr || !enr.actif()) return;
      if (maintenant - dernier > 60) {
        dernier = maintenant;
        const niveau = enr.niveau();
        setNiveaux((avant) => [...avant.slice(1), niveau]);
        const duree = enr.dureeMs();
        setDureeMs(duree);
        if (duree >= DUREE_MAX_MS) {
          terminerRef.current();
          return;
        }
      }
      animation.current = window.requestAnimationFrame(tick);
    };
    animation.current = window.requestAnimationFrame(tick);
  }, []);

  const echouer = useCallback((message: string, winH = true) => {
    setErreur({ message, winH });
    setPhase("erreur");
  }, []);

  const demarrer = useCallback(async () => {
    if (phase === "enregistrement" || phase === "demarrage" || phase === "transcription") return;
    setErreur(null);
    setInfo(null);
    if (!microDisponible()) {
      echouer(messageErreurMicro("non-supporte"));
      return;
    }
    const enr = new EnregistreurVoix();
    enregistreur.current = enr;
    setPhase("demarrage");
    setNiveaux(Array(NB_BARRES).fill(0));
    setDureeMs(0);
    try {
      await enr.demarrer();
    } catch (err) {
      enregistreur.current = null;
      echouer(messageErreurMicro(classerErreurMicro(err)));
      return;
    }
    if (enregistreur.current !== enr) {
      enr.annuler();
      return;
    }
    setPhase("enregistrement");
    animer();
  }, [animer, echouer, phase]);

  const annuler = useCallback(() => {
    arreterAnimation();
    const enr = enregistreur.current;
    enregistreur.current = null;
    enr?.annuler();
    const demande = demandeCourante.current;
    demandeCourante.current = null;
    if (demande) void invoke("voix_annuler", { input: { demande } }).catch(() => undefined);
    setPhase("repos");
    setDureeMs(0);
  }, [arreterAnimation]);

  const terminer = useCallback(async () => {
    const enr = enregistreur.current;
    if (!enr || !enr.actif()) return;
    arreterAnimation();
    enregistreur.current = null;
    const demande = nouvelleDemande();
    demandeCourante.current = demande;
    debutTranscription.current = performance.now();
    setPhase("transcription");
    try {
      const { blob, mime, dureeMs: duree } = await enr.terminer();
      if (blob.size === 0 || duree < 300) {
        demandeCourante.current = null;
        setPhase("repos");
        setInfo("Enregistrement trop court.");
        return;
      }
      const audio = await blobEnBase64(blob);
      const reglages = lireReglagesVoix();
      const { workspacePath: espace, modele: chat } = contexteRef.current;
      const resultat = await invoke<ResultatTranscription>("voix_transcrire", {
        input: {
          audio,
          mime,
          durationMs: Math.round(duree),
          workspacePath: espace ?? null,
          vocabulaire: reglages.vocabulaire || null,
          nettoyer: reglages.nettoyer,
          provider: chat?.provider ?? null,
          model: chat?.name ?? null,
          repliOpenai: reglages.repliOpenai,
          rapide: reglages.rapide,
          demande,
        },
      });
      if (demandeCourante.current !== demande) return; // annulée entre-temps
      demandeCourante.current = null;
      const texte = (resultat.text ?? "").trim();
      if (!texte) {
        echouer("Rien n'a été compris. Réessayez plus près du micro.", false);
        return;
      }
      onTexteRef.current(texte);
      setPhase("repos");
      const secondes = ((resultat.ms ?? 0) / 1000).toFixed(1).replace(".", ",");
      const morceaux = [
        `Transcrit par ${resultat.moteur ?? "le moteur"} en ${secondes} s${resultat.nettoye ? ", nettoyé par l'IA" : ""}.`,
        ...(resultat.avertissements ?? []),
      ];
      setInfo(morceaux.join(" "));
    } catch (err) {
      if (demandeCourante.current !== demande) return;
      demandeCourante.current = null;
      const message = texteErreur(err);
      if (message.includes(ANNULE)) {
        setPhase("repos");
        return;
      }
      echouer(message);
    }
  }, [arreterAnimation, echouer]);
  terminerRef.current = () => void terminer();

  const fermer = useCallback(() => {
    setErreur(null);
    setInfo(null);
    if (phase === "erreur") setPhase("repos");
  }, [phase]);

  /** Secours : dictée Windows (Win+H) dans la zone de saisie. */
  const dicteeWindows = useCallback(() => {
    fermer();
    (document.querySelector(".composer textarea") as HTMLTextAreaElement | null)?.focus();
    void invoke("voice_dictation").catch(() =>
      window.alert("Appuyez sur Windows + H pour dicter dans la zone de saisie."),
    );
  }, [fermer]);

  // Échap annule pendant l'enregistrement ou la transcription.
  useEffect(() => {
    if (phase !== "enregistrement" && phase !== "transcription" && phase !== "demarrage") return;
    const surTouche = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        annuler();
      }
    };
    window.addEventListener("keydown", surTouche, true);
    return () => window.removeEventListener("keydown", surTouche, true);
  }, [annuler, phase]);

  // L'info s'efface seule ; l'erreur reste jusqu'à fermeture.
  useEffect(() => {
    if (!info) return;
    const minuterie = window.setTimeout(() => setInfo(null), 6000);
    return () => window.clearTimeout(minuterie);
  }, [info]);

  // Démontage (changement de conversation) : micro libéré, transcription oubliée.
  useEffect(
    () => () => {
      arreterAnimation();
      enregistreur.current?.annuler();
      enregistreur.current = null;
      const demande = demandeCourante.current;
      demandeCourante.current = null;
      if (demande) void invoke("voix_annuler", { input: { demande } }).catch(() => undefined);
    },
    [arreterAnimation],
  );

  return {
    phase,
    niveaux,
    dureeMs,
    erreur,
    info,
    debutTranscription: debutTranscription.current,
    demarrer,
    terminer,
    annuler,
    fermer,
    dicteeWindows,
  };
}

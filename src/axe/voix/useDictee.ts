import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  classerErreurMicro,
  EnregistreurVoix,
  messageErreurMicro,
  microDisponible,
} from "./enregistreur";
import { lireReglagesVoix } from "./reglages";
import { blobEnPcm16k, MIME_PCM, pcmEnBase64 } from "./pcm"; // axe:micro-local
import {
  apercuTropLent,
  assemblerProvisoire,
  choisirTaille,
  doitCouper,
  ecrireMesure,
  lireMesure,
  noterMesure,
  reechantillonner,
  type TailleWhisper,
} from "./direct";

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

/** axe:0.1.75 — SavIDE : réglage du modèle local -> taille, et taille -> modèle local. */
function reglageTaille(modele: "auto" | "base" | "small"): "auto" | TailleWhisper {
  return modele === "small" ? "moyen" : modele === "base" ? "petit" : "auto";
}
function modeleDe(taille: TailleWhisper): "base" | "small" {
  return taille === "petit" ? "base" : "small";
}

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
  // axe:0.1.75 — dictée en direct : morceaux de ≈ 3 s transcrits au fil de l'eau.
  const [provisoire, setProvisoire] = useState("");
  const morceauxTexte = useRef<string[]>([]);
  const fileMorceaux = useRef<{ audio: Float32Array; ms: number }[]>([]);
  const morceauEnCours = useRef(false);
  const directActif = useRef(false);
  const tailleSession = useRef<TailleWhisper>("moyen");
  const facteurs = useRef<number[]>([]);
  const session = useRef(0);
  const minuterieDirect = useRef<number | null>(null);
  const moyenPresent = useRef(false);
  useEffect(() => {
    void invoke<{ local?: { modeles?: { nom: string; present: boolean }[] } }>("voix_etat", { input: {} })
      .then((e) => { moyenPresent.current = e?.local?.modeles?.some((m) => m.nom === "small" && m.present) ?? false; })
      .catch(() => undefined);
  }, []);

  const arreterDirect = useCallback(() => {
    directActif.current = false;
    if (minuterieDirect.current !== null) window.clearInterval(minuterieDirect.current);
    minuterieDirect.current = null;
    fileMorceaux.current = [];
  }, []);

  const viderProvisoire = useCallback(() => {
    morceauxTexte.current = [];
    setProvisoire("");
  }, []);

  /** Transcrit les morceaux en attente, un à la fois (les retardataires sont regroupés). */
  const pomper = useCallback(async () => {
    if (morceauEnCours.current || !directActif.current) return;
    const file = fileMorceaux.current;
    if (file.length === 0) return;
    // En retard de plus d'un morceau : on les recolle (un seul appel).
    const lot = file.splice(0, file.length);
    const total = lot.reduce((n, m) => n + m.audio.length, 0);
    const audio = new Float32Array(total);
    let pos = 0;
    for (const m of lot) {
      audio.set(m.audio, pos);
      pos += m.audio.length;
    }
    const audioMs = lot.reduce((n, m) => n + m.ms, 0);
    const maSession = session.current;
    morceauEnCours.current = true;
    try {
      const reglages = lireReglagesVoix();
      const { workspacePath: espace } = contexteRef.current;
      const r = await invoke<ResultatTranscription & { taille?: string | null }>("voix_transcrire", {
        input: {
          // axe:micro-local — SavIDE : PCM 16 kHz pour whisper.cpp embarqué.
          audio: pcmEnBase64(audio),
          mime: MIME_PCM,
          local: true,
          modeleLocal: modeleDe(tailleSession.current),
          durationMs: Math.round(audioMs),
          workspacePath: espace ?? null,
          vocabulaire: reglages.vocabulaire || null,
          nettoyer: false,
          taille: tailleSession.current,
          morceau: true,
          // Fenêtre réduite à la durée du morceau : small ≈ 1,1× le temps réel au lieu de 3,4× (mesuré sur la VM).
          rapide: true,
          repliOpenai: false,
        },
      });
      if (session.current !== maSession || !directActif.current) return;
      const texte = (r.text ?? "").trim();
      if (texte) {
        morceauxTexte.current.push(texte);
        setProvisoire(assemblerProvisoire(morceauxTexte.current));
      }
      const duree = r.transcriptionMs ?? r.ms ?? 0;
      const facteur = duree / Math.max(1, audioMs);
      facteurs.current.push(facteur);
      if (reglages.modeleLocal === "auto") {
        const mesure = noterMesure(lireMesure(), r.taille ?? tailleSession.current, audioMs, duree);
        ecrireMesure(mesure);
        if (mesure?.taille === "petit") tailleSession.current = "petit";
      }
      if (apercuTropLent(facteurs.current)) {
        arreterDirect();
        setInfo("Aperçu en direct arrêté : le moteur ne suit pas. La transcription complète arrive à la fin.");
      }
    } catch {
      // Un morceau raté n'arrête pas la dictée : le texte final le contiendra.
    } finally {
      morceauEnCours.current = false;
      if (directActif.current && fileMorceaux.current.length > 0) void pomper();
    }
  }, [arreterDirect]);

  const demarrerDirect = useCallback((enr: EnregistreurVoix) => {
    const reglages = lireReglagesVoix();
    session.current += 1;
    viderProvisoire();
    facteurs.current = [];
    tailleSession.current = choisirTaille(reglageTaille(reglages.modeleLocal), lireMesure());
    // Automatique : le moyen (small) n'est pas encore sur le poste -> petit pour cette
    // dictée, et téléchargement du moyen en arrière-plan (gratuit, empreinte vérifiée).
    if (reglages.modeleLocal === "auto" && tailleSession.current === "moyen" && !moyenPresent.current) {
      tailleSession.current = "petit";
      void invoke<{ modeles?: { nom: string; present: boolean }[] }>("voix_modele_local", { input: { modele: "small" } })
        .then((etat) => { moyenPresent.current = etat?.modeles?.some((m) => m.nom === "small" && m.present) ?? false; })
        .catch(() => undefined);
    }
    if (!reglages.direct || !enr.directPossible()) return;
    directActif.current = true;
    minuterieDirect.current = window.setInterval(() => {
      if (!directActif.current || enregistreur.current !== enr) return;
      if (!doitCouper(enr.pcmEnAttenteMs(), enr.silenceMs())) return;
      const ms = enr.pcmEnAttenteMs();
      const { echantillons, frequence } = enr.prendrePcm();
      fileMorceaux.current.push({ audio: reechantillonner(echantillons, frequence), ms });
      void pomper();
    }, 250);
  }, [pomper, viderProvisoire]);

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
    demarrerDirect(enr);
  }, [animer, demarrerDirect, echouer, phase]);

  const annuler = useCallback(() => {
    arreterAnimation();
    arreterDirect();
    session.current += 1;
    viderProvisoire();
    const enr = enregistreur.current;
    enregistreur.current = null;
    enr?.annuler();
    const demande = demandeCourante.current;
    demandeCourante.current = null;
    if (demande) void invoke("voix_annuler", { input: { demande } }).catch(() => undefined);
    setPhase("repos");
    setDureeMs(0);
  }, [arreterAnimation, arreterDirect, viderProvisoire]);

  const terminer = useCallback(async () => {
    const enr = enregistreur.current;
    if (!enr || !enr.actif()) return;
    arreterAnimation();
    arreterDirect();
    enregistreur.current = null;
    const taille = tailleSession.current;
    const demande = nouvelleDemande();
    demandeCourante.current = demande;
    debutTranscription.current = performance.now();
    setPhase("transcription");
    try {
      const { blob, dureeMs: duree } = await enr.terminer();
      if (blob.size === 0 || duree < 300) {
        demandeCourante.current = null;
        setPhase("repos");
        viderProvisoire();
        setInfo("Enregistrement trop court.");
        return;
      }
      // axe:micro-local — SavIDE : whisper.cpp embarqué, audio décodé ici en PCM 16 kHz.
      const audio = pcmEnBase64(await blobEnPcm16k(blob));
      const reglages = lireReglagesVoix();
      const { workspacePath: espace, modele: chat } = contexteRef.current;
      const resultat = await invoke<ResultatTranscription>("voix_transcrire", {
        input: {
          audio,
          mime: MIME_PCM,
          local: true,
          modeleLocal: modeleDe(taille),
          durationMs: Math.round(duree),
          workspacePath: espace ?? null,
          vocabulaire: reglages.vocabulaire || null,
          nettoyer: reglages.nettoyer,
          provider: chat?.provider ?? null,
          model: chat?.name ?? null,
          repliOpenai: reglages.repliOpenai,
          rapide: reglages.rapide,
          taille,
          demande,
        },
      });
      if (demandeCourante.current !== demande) return; // annulée entre-temps
      demandeCourante.current = null;
      const texte = (resultat.text ?? "").trim();
      // Le texte final remplace le provisoire.
      viderProvisoire();
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
        viderProvisoire();
        setPhase("repos");
        return;
      }
      // Transcription finale ratée : le texte provisoire vaut mieux que rien.
      const secours = assemblerProvisoire(morceauxTexte.current);
      viderProvisoire();
      if (secours) {
        onTexteRef.current(secours);
        setPhase("repos");
        setInfo(`Texte de l'aperçu en direct inséré (transcription complète impossible : ${message.slice(0, 160)}).`);
        return;
      }
      echouer(message);
    }
  }, [arreterAnimation, arreterDirect, echouer, viderProvisoire]);
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
      arreterDirect();
      enregistreur.current?.annuler();
      enregistreur.current = null;
      const demande = demandeCourante.current;
      demandeCourante.current = null;
      if (demande) void invoke("voix_annuler", { input: { demande } }).catch(() => undefined);
    },
    [arreterAnimation, arreterDirect],
  );

  return {
    provisoire,
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

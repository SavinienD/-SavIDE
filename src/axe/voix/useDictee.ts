import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  classerErreurMicro,
  EnregistreurVoix,
  messageErreurMicro,
  microDisponible,
  plateformeCourante,
} from "./enregistreur";
import { lireReglagesVoix } from "./reglages";
import { blobEnPcm16k, MIME_PCM, pcmEnBase64 } from "./pcm"; // micro-local
import { chargerVocabulaire, vocabulaireEffectif } from "./vocabulaireAuto"; // voix-vocabulaire
import {
  apercuTropLent,
  assemblerProvisoire,
  choisirTaille,
  doitCouper,
  finParMorceaux,
  MORCEAU_MIN_MS,
  RESTE_MIN_MS,
  SILENCE_MS,
  ecrireMesure,
  lireMesure,
  noterMesure,
  reechantillonner,
  type TailleWhisper,
} from "./direct";
import { livrerDicteeRemplacable, type CibleDictee, type Remplacer } from "./dicteeCible";

/** voix — machine à états de la dictée : repos -> enregistrement ->
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
/** 0.1.77 — sans PCM du WebAudio après ce délai, le direct passe aux segments MediaRecorder. */
export const ATTENTE_PCM_MS = 1_500;
export const SEGMENT_MS = 3_000;
/** Fin de dictée : attente maximale des derniers morceaux avant la transcription complète. */
export const ATTENTE_MORCEAUX_MAX_MS = 60_000;

type Options = {
  workspacePath?: string;
  modele?: { provider: string; name: string } | null;
  /** Conversation affichée : devient la cible au début de l'enregistrement. */
  conversationId?: string;
  /** Sans conversationId : le texte va à ce rappel (ancien comportement). */
  onTexte: (texte: string) => Remplacer | void;
};

/** 0.1.75 — SavIDE : réglage du modèle local -> taille, et taille -> modèle local. */
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

export function useDictee({ workspacePath, modele, conversationId, onTexte }: Options) {
  const [phase, setPhase] = useState<PhaseDictee>("repos");
  const [niveaux, setNiveaux] = useState<number[]>(() => Array(NB_BARRES).fill(0));
  const [dureeMs, setDureeMs] = useState(0);
  const [erreur, setErreur] = useState<{ message: string; winH: boolean; reglagesMac?: boolean } | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const enregistreur = useRef<EnregistreurVoix | null>(null);
  const demandeCourante = useRef<string | null>(null);
  const debutTranscription = useRef(0);
  const animation = useRef<number | null>(null);
  const onTexteRef = useRef(onTexte);
  onTexteRef.current = onTexte;
  const contexteRef = useRef({ workspacePath, modele });
  contexteRef.current = { workspacePath, modele };
  // Conversation où la dictée a commencé : le texte y va, même si on a changé
  // de conversation, de colonne ou de dossier entre-temps (elle peut ne plus être affichée).
  const conversationRef = useRef(conversationId);
  conversationRef.current = conversationId;
  const cibleRef = useRef<CibleDictee | null>(null);
  const [cible, setCible] = useState<CibleDictee | null>(null);
  /** De quoi remplacer le dernier texte livré (nettoyage IA arrivé après l'affichage). */
  const dernierRemplacer = useRef<Remplacer | null>(null);
  /** Rend vrai si le texte est allé dans la saisie affichée ici (sinon : brouillon de la
   *  conversation de départ ou presse-papiers, et c'est le message du Workspace qui le dit). */
  const livrer = useCallback((texte: string): boolean => {
    const c = cibleRef.current;
    cibleRef.current = null;
    setCible(null);
    if (!c) {
      const r = onTexteRef.current(texte);
      dernierRemplacer.current = typeof r === "function" ? r : null;
      return true;
    }
    const { ou, remplacer } = livrerDicteeRemplacable(c, texte);
    dernierRemplacer.current = remplacer;
    return ou === "saisie" && c.conversationId === conversationRef.current;
  }, []);
  const terminerRef = useRef<() => void>(() => undefined);
  const annulerRef = useRef<() => void>(() => undefined);
  // 0.1.75 — dictée en direct : morceaux de ≈ 3 s transcrits au fil de l'eau.
  const [provisoire, setProvisoire] = useState("");
  const morceauxTexte = useRef<string[]>([]);
  // 0.1.77 — un segment MediaRecorder (secours) est décodé en PCM avant la file.
  const fileMorceaux = useRef<{ audio: Float32Array; ms: number }[]>([]);
  // 0.1.77 — état visible du direct : l'encadré gris s'affiche dès le début (attente),
  // et dit pourquoi l'aperçu manque au lieu de se taire (erreurs avalées en 0.1.75-0.1.76).
  const [direct, setDirect] = useState<{ actif: boolean; erreur: string | null }>({ actif: false, erreur: null });
  const debutDirect = useRef(0);
  const morceauEnCours = useRef(false);
  const directActif = useRef(false);
  const tailleSession = useRef<TailleWhisper>("moyen");
  const facteurs = useRef<number[]>([]);
  const session = useRef(0);
  const minuterieDirect = useRef<number | null>(null);
  /** Morceaux en erreur dans cette dictée (la fin par morceaux exige zéro). */
  const erreursDirect = useRef(0);
  /** Fin de dictée en cours : les derniers morceaux sont attendus, l'aperçu ne s'arrête plus. */
  const finalisation = useRef(false);
  const moteurDirect = useRef<string | null>(null);
  const moyenPresent = useRef(false);
  // 0.1.77 — le petit (base) aussi peut manquer (premier usage) : sans lui, chaque
  // morceau échouait (« pas encore sur le poste ») et l'aperçu restait vide sans explication.
  const petitPresent = useRef(false);
  useEffect(() => {
    void invoke<{ local?: { modeles?: { nom: string; present: boolean }[] } }>("voix_etat", { input: {} })
      .then((e) => {
        moyenPresent.current = e?.local?.modeles?.some((m) => m.nom === "small" && m.present) ?? false;
        petitPresent.current = e?.local?.modeles?.some((m) => m.nom === "base" && m.present) ?? false;
      })
      .catch(() => undefined);
  }, []);

  const arreterMinuterieDirect = useCallback(() => {
    if (minuterieDirect.current !== null) window.clearInterval(minuterieDirect.current);
    minuterieDirect.current = null;
  }, []);

  const arreterDirect = useCallback(() => {
    directActif.current = false;
    finalisation.current = false;
    setDirect((d) => (d.actif ? { ...d, actif: false } : d));
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
          // micro-local — SavIDE : PCM 16 kHz pour whisper.cpp embarqué.
          audio: pcmEnBase64(audio),
          mime: MIME_PCM,
          local: true,
          modeleLocal: modeleDe(tailleSession.current),
          durationMs: Math.round(audioMs),
          workspacePath: espace ?? null,
          vocabulaire: vocabulaireEffectif(reglages.vocabulaire, chargerVocabulaire()) || null,
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
      if (typeof r.moteur === "string") moteurDirect.current = r.moteur;
      setDirect((d) => (d.erreur ? { ...d, erreur: null } : d));
      const duree = r.transcriptionMs ?? r.ms ?? 0;
      const facteur = duree / Math.max(1, audioMs);
      facteurs.current.push(facteur);
      if (reglages.modeleLocal === "auto") {
        const mesure = noterMesure(lireMesure(), r.taille ?? tailleSession.current, audioMs, duree);
        ecrireMesure(mesure);
        if (mesure?.taille === "petit") tailleSession.current = "petit";
      }
      if (!finalisation.current && apercuTropLent(facteurs.current)) {
        arreterDirect();
        setDirect({ actif: false, erreur: "le moteur ne suit pas, la transcription complète arrive à la fin" });
        setInfo("Aperçu en direct arrêté : le moteur ne suit pas. La transcription complète arrive à la fin.");
      }
    } catch (err) {
      // Un morceau raté n'arrête pas la dictée (le texte final le contiendra), mais la
      // raison s'affiche dans l'encadré du direct.
      if (session.current === maSession) erreursDirect.current += 1;
      if (session.current === maSession && directActif.current) {
        setDirect({ actif: true, erreur: texteErreur(err).slice(0, 200) });
      }
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
    erreursDirect.current = 0;
    finalisation.current = false;
    moteurDirect.current = null;
    tailleSession.current = choisirTaille(reglageTaille(reglages.modeleLocal), lireMesure());
    // Automatique : le moyen (small) n'est pas encore sur le poste -> petit pour cette
    // dictée, et téléchargement du moyen en arrière-plan (gratuit, empreinte vérifiée).
    if (reglages.modeleLocal === "auto" && tailleSession.current === "moyen" && !moyenPresent.current) {
      tailleSession.current = "petit";
      type Etat = { modeles?: { nom: string; present: boolean }[] };
      const noter = (etat: Etat | undefined) => {
        moyenPresent.current = etat?.modeles?.some((m) => m.nom === "small" && m.present) ?? moyenPresent.current;
        petitPresent.current = etat?.modeles?.some((m) => m.nom === "base" && m.present) ?? petitPresent.current;
      };
      // Le petit d'abord (il sert tout de suite à l'aperçu), puis le moyen.
      const petit = petitPresent.current
        ? Promise.resolve()
        : invoke<Etat>("voix_modele_local", { input: { modele: "base" } }).then(noter).catch(() => undefined);
      void petit
        .then(() => invoke<Etat>("voix_modele_local", { input: { modele: "small" } }))
        .then(noter)
        .catch(() => undefined);
    }
    setDirect({ actif: false, erreur: null });
    if (!reglages.direct || !enr.directPossible()) return;
    directActif.current = true;
    debutDirect.current = performance.now();
    setDirect({ actif: true, erreur: null });
    const maSession = session.current;
    const surSegment = (blob: Blob, ms: number) => {
      if (session.current !== maSession || !directActif.current) return;
      // SavIDE : whisper.cpp embarqué attend du PCM 16 kHz (segment webm décodé ici).
      void blobEnPcm16k(blob)
        .then((audio) => {
          if (session.current !== maSession || !directActif.current) return;
          fileMorceaux.current.push({ audio, ms });
          void pomper();
        })
        .catch((err) => setDirect({ actif: true, erreur: texteErreur(err).slice(0, 200) }));
    };
    minuterieDirect.current = window.setInterval(() => {
      if (!directActif.current || enregistreur.current !== enr) return;
      if (enr.segmentsActifs()) return;
      // 0.1.77 — WebAudio muet (contexte suspendu, ScriptProcessor sans rappel) :
      // 1,5 s sans PCM -> segments MediaRecorder de 3 s (cause du direct « vide » sur PC).
      if (!enr.pcmLivre()) {
        if (performance.now() - debutDirect.current >= ATTENTE_PCM_MS) enr.demarrerSegments(SEGMENT_MS, surSegment);
        return;
      }
      if (!doitCouper(enr.pcmEnAttenteMs(), enr.silenceMs())) return;
      // Pas de silence (coupe forcée) : coupe au moment le plus calme, pas en plein mot.
      const { echantillons, frequence } = enr.prendrePcm(enr.silenceMs() < SILENCE_MS ? MORCEAU_MIN_MS : 0);
      const ms = (echantillons.length / frequence) * 1000;
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

  // Win+H n'existe que sous Windows ; sur Mac, un refus du micro propose d'ouvrir les Réglages.
  const echouer = useCallback((message: string, winH = true, reglagesMac = false) => {
    const plateforme = plateformeCourante();
    setErreur({ message, winH: winH && plateforme === "windows", reglagesMac: reglagesMac && plateforme === "mac" });
    cibleRef.current = null;
    setCible(null);
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
    const id = conversationRef.current;
    cibleRef.current = id ? { conversationId: id, workspacePath: contexteRef.current.workspacePath ?? null } : null;
    setCible(cibleRef.current);
    setPhase("demarrage");
    setNiveaux(Array(NB_BARRES).fill(0));
    setDureeMs(0);
    try {
      await enr.demarrer();
    } catch (err) {
      enregistreur.current = null;
      const type = classerErreurMicro(err);
      echouer(messageErreurMicro(type), true, type === "refuse");
      return;
    }
    if (enregistreur.current !== enr) {
      enr.annuler();
      return;
    }
    // Conversation changée pendant l'ouverture du micro : rien n'a encore été dit.
    if (cibleRef.current && cibleRef.current.conversationId !== conversationRef.current) {
      annulerRef.current();
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
    cibleRef.current = null;
    setCible(null);
    const enr = enregistreur.current;
    enregistreur.current = null;
    enr?.annuler();
    const demande = demandeCourante.current;
    demandeCourante.current = null;
    if (demande) void invoke("voix_annuler", { input: { demande } }).catch(() => undefined);
    setPhase("repos");
    setDureeMs(0);
  }, [arreterAnimation, arreterDirect, viderProvisoire]);
  annulerRef.current = annuler;

  /** Attend les derniers morceaux de l'aperçu ; rend leur texte, ou null (erreur, annulation, vide). */
  const texteDesMorceaux = useCallback(async (maSession: number): Promise<string | null> => {
    const limite = performance.now() + ATTENTE_MORCEAUX_MAX_MS;
    while (session.current === maSession && (morceauEnCours.current || fileMorceaux.current.length > 0)) {
      if (performance.now() > limite) return null;
      await new Promise((fin) => window.setTimeout(fin, 40));
    }
    if (session.current !== maSession || erreursDirect.current > 0) return null;
    return assemblerProvisoire(morceauxTexte.current) || null;
  }, []);

  /**
   * Nettoyage IA après l'affichage : le texte déjà transcrit part seul (aucune
   * retranscription) au modèle du chat ; le résultat remplace le texte brut s'il est
   * resté intact dans la saisie (ou le brouillon), sinon le texte de l'utilisateur est gardé.
   */
  const nettoyerApres = useCallback(async (
    brut: string,
    remplacer: Remplacer,
    ctx: { espace?: string; chat?: { provider: string; name: string } | null; vocabulaire: string | null },
  ) => {
    try {
      const r = await invoke<ResultatTranscription>("voix_transcrire", {
        input: {
          audio: "",
          mime: MIME_PCM,
          local: true,
          workspacePath: ctx.espace ?? null,
          vocabulaire: ctx.vocabulaire,
          nettoyer: true,
          provider: ctx.chat?.provider ?? null,
          model: ctx.chat?.name ?? null,
          repliOpenai: false,
          texte: brut,
          demande: nouvelleDemande(),
        },
      });
      const propre = (r.text ?? "").trim();
      if (r.nettoye && propre && propre !== brut.trim()) {
        setInfo(remplacer(propre) ? "Texte nettoyé par l'IA." : "Nettoyage IA non appliqué : le texte a été modifié entre-temps.");
      } else if (r.avertissements?.length) {
        setInfo(r.avertissements.join(" "));
      }
    } catch (err) {
      setInfo(`Nettoyage IA indisponible : texte brut gardé (${texteErreur(err).slice(0, 160)}).`);
    }
  }, []);

  const terminer = useCallback(async () => {
    const enr = enregistreur.current;
    if (!enr || !enr.actif()) return;
    arreterAnimation();
    // Aperçu en direct sain : le texte des morceaux est gardé et seule la fin pas encore
    // envoyée est transcrite (fenêtre réduite), au lieu de retranscrire tout l'enregistrement.
    const parMorceaux = finParMorceaux({
      actif: directActif.current,
      pcm: enr.pcmLivre(),
      segments: enr.segmentsActifs(),
      erreurs: erreursDirect.current,
    });
    if (parMorceaux) {
      arreterMinuterieDirect();
      finalisation.current = true;
      // Fin sans voix (silence depuis la dernière coupe) : rien à transcrire, pas d'appel de plus.
      const muette = enr.silenceMs() >= enr.pcmEnAttenteMs();
      const { echantillons, frequence } = enr.prendrePcm();
      const ms = (echantillons.length / frequence) * 1000;
      if (ms >= RESTE_MIN_MS && !muette) fileMorceaux.current.push({ audio: reechantillonner(echantillons, frequence), ms });
      void pomper();
    } else {
      arreterDirect();
    }
    const maSession = session.current;
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
        cibleRef.current = null;
        setCible(null);
        setPhase("repos");
        arreterDirect();
        viderProvisoire();
        setInfo("Enregistrement trop court.");
        return;
      }
      const texteDirect = parMorceaux ? await texteDesMorceaux(maSession) : null;
      arreterDirect();
      if (demandeCourante.current !== demande) return; // annulée entre-temps
      const reglagesFin = lireReglagesVoix();
      const { workspacePath: espace, modele: chat } = contexteRef.current;
      const vocabulaire = vocabulaireEffectif(reglagesFin.vocabulaire, chargerVocabulaire()) || null;
      // Le texte brut s'affiche tout de suite. Le nettoyage IA (un aller-retour vers le modèle
      // du chat : plusieurs secondes) suit sans bloquer et ne remplace le texte que si
      // l'utilisateur n'y a pas touché entre-temps.
      const nettoyerEnsuite = (brut: string) => {
        const remplacer = dernierRemplacer.current;
        dernierRemplacer.current = null;
        if (reglagesFin.nettoyer && brut && remplacer) void nettoyerApres(brut, remplacer, { espace, chat, vocabulaire });
      };
      if (texteDirect) {
        demandeCourante.current = null;
        viderProvisoire();
        const ici = livrer(texteDirect);
        setPhase("repos");
        nettoyerEnsuite(texteDirect);
        if (!ici) return;
        const secondes = ((performance.now() - debutTranscription.current) / 1000).toFixed(1).replace(".", ",");
        setInfo(`Transcrit en direct par ${moteurDirect.current ?? "le moteur"} en ${secondes} s.`);
        return;
      }
      // Audio décodé ici en PCM 16 kHz pour whisper.cpp embarqué.
      const audio = pcmEnBase64(await blobEnPcm16k(blob));
      const resultat = await invoke<ResultatTranscription>("voix_transcrire", {
        input: {
          audio,
          mime: MIME_PCM,
          local: true,
          modeleLocal: modeleDe(taille),
          durationMs: Math.round(duree),
          workspacePath: espace ?? null,
          vocabulaire,
          nettoyer: false,
          repliOpenai: reglagesFin.repliOpenai,
          rapide: reglagesFin.rapide,
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
      const ici = livrer(texte);
      setPhase("repos");
      nettoyerEnsuite(texte);
      if (!ici) return;
      const secondes = ((resultat.ms ?? 0) / 1000).toFixed(1).replace(".", ",");
      const morceaux = [
        `Transcrit par ${resultat.moteur ?? "le moteur"} en ${secondes} s.`,
        ...(resultat.avertissements ?? []),
      ];
      setInfo(morceaux.join(" "));
    } catch (err) {
      if (demandeCourante.current !== demande) return;
      demandeCourante.current = null;
      const message = texteErreur(err);
      if (message.includes(ANNULE)) {
        cibleRef.current = null;
        setCible(null);
        viderProvisoire();
        setPhase("repos");
        return;
      }
      // Transcription finale ratée : le texte provisoire vaut mieux que rien.
      const secours = assemblerProvisoire(morceauxTexte.current);
      viderProvisoire();
      if (secours) {
        const ici = livrer(secours);
        setPhase("repos");
        if (!ici) return;
        setInfo(`Texte de l'aperçu en direct inséré (transcription complète impossible : ${message.slice(0, 160)}).`);
        return;
      }
      echouer(message);
    }
  }, [arreterAnimation, arreterDirect, arreterMinuterieDirect, echouer, livrer, nettoyerApres, pomper, texteDesMorceaux, viderProvisoire]);
  terminerRef.current = () => void terminer();

  // On change de conversation pendant l'enregistrement : l'enregistrement s'arrête
  // et part en transcription vers la conversation de départ (rien n'est perdu, et l'aperçu
  // en direct ne s'affiche jamais dans une autre conversation).
  useEffect(() => {
    const c = cibleRef.current;
    if (!c || c.conversationId === conversationId) return;
    if (enregistreur.current?.actif()) terminerRef.current();
  }, [conversationId]);

  const fermer = useCallback(() => {
    setErreur(null);
    setInfo(null);
    if (phase === "erreur") setPhase("repos");
  }, [phase]);

  /** Secours : dictée Windows (Win+H) dans la zone de saisie. */
  // La zone de saisie de CE compositeur (avant : la première de la page,
  // celle d'une autre colonne quand il y en a plusieurs).
  const dicteeWindows = useCallback((zone?: HTMLTextAreaElement | null) => {
    fermer();
    (zone ?? (document.querySelector(".composer textarea") as HTMLTextAreaElement | null))?.focus();
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

  // Démontage (autre colonne, autre dossier, fenêtre détachée…) : l'enregistrement
  // en cours est terminé et transcrit, la transcription en cours continue ; le texte va
  // à la conversation de départ (brouillon si elle n'est plus affichée). Sans cible
  // (ancien appel), comme avant : micro libéré, transcription oubliée.
  useEffect(
    () => () => {
      if (cibleRef.current) {
        if (enregistreur.current?.actif()) terminerRef.current();
        return;
      }
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

  const ouvrirReglagesMicro = useCallback(() => {
    void invoke("voix_ouvrir_reglages_micro").catch(() => undefined);
  }, []);

  return {
    ouvrirReglagesMicro,
    cible,
    provisoire,
    direct,
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

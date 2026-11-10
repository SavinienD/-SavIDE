/**
 * voix — enregistrement du micro dans la WebView (getUserMedia + MediaRecorder,
 * webm/opus) et niveau sonore (AnalyserNode) pour l'onde affichée.
 *
 * WebView2 (Windows) : la première demande ouvre l'invite d'autorisation du micro
 * de WebView2 ; la décision est mémorisée dans le profil de l'appli. Si Windows
 * bloque le micro (Paramètres > Confidentialité > Microphone > « Autoriser les
 * applications de bureau »), getUserMedia échoue : l'interface propose alors la
 * dictée Windows (Win+H). La capture native (cpal côté Rust) reste possible si
 * WebView2 venait à bloquer MediaRecorder : non nécessaire à ce jour.
 */

export type ErreurMicro = "non-supporte" | "refuse" | "aucun-micro" | "occupe" | "autre";

export type Enregistrement = { blob: Blob; mime: string; dureeMs: number };

const TYPES_PREFERES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"];

function choisirType(): string {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  return TYPES_PREFERES.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

export function microDisponible(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

export function classerErreurMicro(err: unknown): ErreurMicro {
  const nom = (err as { name?: string } | null)?.name ?? "";
  if (nom === "NotAllowedError" || nom === "SecurityError" || nom === "PermissionDeniedError") return "refuse";
  if (nom === "NotFoundError" || nom === "OverconstrainedError" || nom === "DevicesNotFoundError") return "aucun-micro";
  if (nom === "NotReadableError" || nom === "TrackStartError" || nom === "AbortError") return "occupe";
  return "autre";
}

export type Plateforme = "mac" | "windows" | "linux";

export function plateformeCourante(): Plateforme {
  const p = typeof navigator !== "undefined" ? `${navigator.platform} ${navigator.userAgent}` : "";
  if (/mac/i.test(p)) return "mac";
  if (/win/i.test(p)) return "windows";
  return "linux";
}

export function messageErreurMicro(type: ErreurMicro, plateforme: Plateforme = plateformeCourante()): string {
  switch (type) {
    case "non-supporte":
      return "Enregistrement audio indisponible dans cette fenêtre.";
    case "refuse":
      if (plateforme === "mac")
        return "Micro refusé par macOS. Autorisez SavIDE dans Réglages Système > Confidentialité et sécurité > Micro, puis relancez l'appli.";
      if (plateforme === "windows")
        return "Micro refusé. Autorisez-le (invite de l'appli, ou Paramètres Windows > Confidentialité > Microphone > « Autoriser les applications de bureau »).";
      return "Micro refusé. Autorisez l'accès au micro pour SavIDE dans les réglages du système.";
    case "aucun-micro":
      return "Aucun micro détecté.";
    case "occupe":
      return "Le micro est occupé par une autre application.";
    default:
      return "Impossible de démarrer le micro.";
  }
}

export class EnregistreurVoix {
  private flux: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private morceaux: Blob[] = [];
  private contexte: AudioContext | null = null;
  private analyseur: AnalyserNode | null = null;
  private tampon: Float32Array<ArrayBuffer> | null = null;
  private debut = 0;
  private type = "";
  // 0.1.75 — PCM pour la dictée en direct (morceaux WAV de ≈ 3 s).
  private processeur: ScriptProcessorNode | null = null;
  private pcm: Float32Array[] = [];
  private pcmLongueur = 0;
  /** Niveau RMS de chaque bloc de `pcm` (coupe au point le plus calme). */
  private pcmNiveaux: number[] = [];
  /** Bruit de fond du micro (seuil de silence adaptatif). */
  private plancher = 0.005;
  private dernierSon = 0;
  private frequence = 48_000;
  // 0.1.77 — PCM reçu depuis le début (0 = WebAudio muet) et secours par segments MediaRecorder.
  private pcmTotal = 0;
  private segment: MediaRecorder | null = null;
  private minuterieSegment: number | null = null;

  async demarrer(): Promise<void> {
    const flux = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // Whisper supporte bien le bruit ; la suppression de bruit WebRTC peut
        // rogner les consonnes et dégrader la reconnaissance.
        noiseSuppression: false,
        autoGainControl: true,
      },
    });
    this.flux = flux;
    const type = choisirType();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(flux, {
        ...(type ? { mimeType: type } : {}),
        audioBitsPerSecond: 48_000,
      });
    } catch (err) {
      this.liberer();
      throw err;
    }
    this.type = recorder.mimeType || type || "audio/webm";
    this.morceaux = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) this.morceaux.push(event.data);
    };
    // Morceaux d'une seconde : un même flux webm, recollé à la fin.
    recorder.start(1000);
    this.recorder = recorder;
    this.debut = performance.now();
    try {
      const Contexte =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Contexte) {
        this.contexte = new Contexte();
        // 0.1.77 — contexte créé après l'attente du micro : il peut naître « suspendu »
        // (règle d'autoplay de WebView2) ; suspendu, il ne livre ni niveau ni PCM.
        if (this.contexte.state === "suspended") void this.contexte.resume().catch(() => undefined);
        const source = this.contexte.createMediaStreamSource(flux);
        this.analyseur = this.contexte.createAnalyser();
        this.analyseur.fftSize = 1024;
        this.tampon = new Float32Array(new ArrayBuffer(this.analyseur.fftSize * 4));
        source.connect(this.analyseur);
        this.frequence = this.contexte.sampleRate;
        try {
          // ScriptProcessor (simple, sans fichier de worklet) : copie du signal ; sortie muette.
          const proc = this.contexte.createScriptProcessor(4096, 1, 1);
          proc.onaudioprocess = (event) => {
            const canal = event.inputBuffer.getChannelData(0);
            this.pcm.push(new Float32Array(canal));
            this.pcmLongueur += canal.length;
            this.pcmTotal += canal.length;
            let somme = 0;
            for (let i = 0; i < canal.length; i += 1) somme += canal[i] * canal[i];
            const rms = Math.sqrt(somme / canal.length);
            this.pcmNiveaux.push(rms);
            // Seuil au-dessus du bruit de fond : avec le gain automatique, un seuil fixe
            // ne voyait aucun silence et chaque morceau était coupé à 4,5 s en plein mot.
            if (rms > seuilSon(this.plancher)) this.dernierSon = performance.now();
            this.plancher = suivrePlancher(this.plancher, rms);
          };
          source.connect(proc);
          proc.connect(this.contexte.destination);
          this.processeur = proc;
          this.dernierSon = performance.now();
        } catch {
          /* pas d'aperçu en direct : la transcription finale reste */
        }
      }
    } catch {
      /* pas de niveau : l'enregistrement continue */
    }
  }

  /** Durée du son capté depuis la dernière coupe (dictée en direct). */
  pcmEnAttenteMs(): number {
    return (this.pcmLongueur / this.frequence) * 1000;
  }

  /** Durée du silence en cours. */
  silenceMs(): number {
    return this.processeur ? performance.now() - this.dernierSon : 0;
  }

  /** 0.1.77 — le direct marche aussi sans WebAudio (segments MediaRecorder). */
  directPossible(): boolean {
    return this.flux !== null;
  }

  /** 0.1.77 — le WebAudio livre-t-il du son ? (faux : passer aux segments) */
  pcmLivre(): boolean {
    return this.processeur !== null && this.pcmTotal > 0;
  }

  segmentsActifs(): boolean {
    return this.segment !== null;
  }

  /**
   * 0.1.77 — secours du direct quand le WebAudio ne livre rien : un second
   * MediaRecorder sur le même flux, arrêté et relancé toutes les `dureeMs`. Chaque
   * segment est un fichier webm/opus complet, transcrit à part.
   */
  demarrerSegments(dureeMs: number, surSegment: (blob: Blob, ms: number) => void): boolean {
    const flux = this.flux;
    if (!flux || this.segment || typeof MediaRecorder === "undefined") return false;
    const lancer = () => {
      if (!this.flux) return;
      let r: MediaRecorder;
      try {
        r = new MediaRecorder(this.flux, { ...(this.type ? { mimeType: this.type } : {}), audioBitsPerSecond: 48_000 });
      } catch {
        this.segment = null;
        return;
      }
      const parts: Blob[] = [];
      const debut = performance.now();
      r.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) parts.push(event.data);
      };
      r.onstop = () => {
        const actif = this.segment === r;
        if (parts.length > 0 && actif) surSegment(new Blob(parts, { type: r.mimeType || this.type }), performance.now() - debut);
        if (actif) lancer();
      };
      this.segment = r;
      r.start();
      this.minuterieSegment = window.setTimeout(() => {
        if (r.state !== "inactive") r.stop();
      }, dureeMs);
    };
    lancer();
    return this.segment !== null;
  }

  private arreterSegments(): void {
    if (this.minuterieSegment !== null) window.clearTimeout(this.minuterieSegment);
    this.minuterieSegment = null;
    const r = this.segment;
    this.segment = null;
    try {
      if (r && r.state !== "inactive") r.stop();
    } catch {
      /* déjà arrêté */
    }
  }

  /**
   * Prend le son capté depuis la dernière coupe (fréquence du micro). `auCalmeApresMs` > 0 :
   * coupe forcée sans silence, on s'arrête au bloc le plus calme après ce délai (le reste
   * attend le morceau suivant) au lieu de couper au milieu d'un mot.
   */
  prendrePcm(auCalmeApresMs = 0): { echantillons: Float32Array; frequence: number } {
    let n = this.pcm.length;
    if (auCalmeApresMs > 0 && this.pcm.length > 1 && this.pcmNiveaux.length === this.pcm.length) {
      const blocMs = (this.pcmLongueur / this.pcm.length / this.frequence) * 1000;
      n = blocsJusquAuCalme(this.pcmNiveaux, blocMs, auCalmeApresMs);
    }
    const blocs = this.pcm.slice(0, n);
    const longueur = blocs.reduce((t, b) => t + b.length, 0);
    const sortie = new Float32Array(longueur);
    let pos = 0;
    for (const bloc of blocs) {
      sortie.set(bloc, pos);
      pos += bloc.length;
    }
    this.pcm = this.pcm.slice(n);
    this.pcmNiveaux = this.pcmNiveaux.slice(n);
    this.pcmLongueur -= longueur;
    return { echantillons: sortie, frequence: this.frequence };
  }

  /** Niveau 0..1 (RMS amplifié) pour l'onde. */
  niveau(): number {
    const analyseur = this.analyseur;
    const tampon = this.tampon;
    if (!analyseur || !tampon) return 0;
    analyseur.getFloatTimeDomainData(tampon);
    let somme = 0;
    for (let i = 0; i < tampon.length; i += 1) somme += tampon[i] * tampon[i];
    const rms = Math.sqrt(somme / tampon.length);
    return Math.min(1, Math.sqrt(rms) * 1.6);
  }

  dureeMs(): number {
    return this.recorder ? performance.now() - this.debut : 0;
  }

  actif(): boolean {
    return this.recorder !== null;
  }

  async terminer(): Promise<Enregistrement> {
    const recorder = this.recorder;
    if (!recorder) throw new Error("aucun enregistrement en cours");
    const dureeMs = performance.now() - this.debut;
    if (recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      });
    }
    const blob = new Blob(this.morceaux, { type: this.type });
    this.morceaux = [];
    this.liberer();
    return { blob, mime: this.type, dureeMs };
  }

  annuler(): void {
    try {
      if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    } catch {
      /* déjà arrêté */
    }
    this.morceaux = [];
    this.liberer();
  }

  private liberer(): void {
    this.arreterSegments();
    this.flux?.getTracks().forEach((piste) => piste.stop());
    this.flux = null;
    this.recorder = null;
    if (this.processeur) {
      this.processeur.onaudioprocess = null;
      try { this.processeur.disconnect(); } catch { /* déjà déconnecté */ }
    }
    this.processeur = null;
    this.pcm = [];
    this.pcmLongueur = 0;
    this.pcmNiveaux = [];
    const contexte = this.contexte;
    this.contexte = null;
    this.analyseur = null;
    this.tampon = null;
    if (contexte) void contexte.close().catch(() => undefined);
  }
}

/**
 * Coupe d'un morceau forcée (8 s sans silence) : au bloc le plus calme après
 * `minMs` plutôt qu'au milieu d'un mot. `niveaux` = niveau RMS de chaque bloc de PCM,
 * `blocMs` = durée d'un bloc. Rend le nombre de blocs à prendre (bloc calme compris).
 */
export function blocsJusquAuCalme(niveaux: number[], blocMs: number, minMs: number): number {
  if (niveaux.length === 0 || !(blocMs > 0)) return niveaux.length;
  const premier = Math.min(niveaux.length - 1, Math.max(0, Math.ceil(minMs / blocMs) - 1));
  let meilleur = niveaux.length - 1;
  for (let i = premier; i < niveaux.length; i += 1) {
    if (niveaux[i] < niveaux[meilleur]) meilleur = i;
  }
  return meilleur + 1;
}

/** Seuil de son : au-dessus du bruit de fond mesuré (un seuil fixe ne voit aucun silence sur un micro bruité). */
export const SEUIL_SON_MIN = 0.006;
export const SEUIL_SON_MAX = 0.03;
export function seuilSon(plancher: number): number {
  return Math.min(SEUIL_SON_MAX, Math.max(SEUIL_SON_MIN, plancher * 2.5));
}

/** Bruit de fond : suit tout de suite une baisse, monte lentement (la voix ne le relève pas). */
export function suivrePlancher(plancher: number, niveau: number): number {
  if (!(niveau >= 0)) return plancher;
  return niveau < plancher ? niveau : plancher + (niveau - plancher) * 0.02;
}

export async function blobEnBase64(blob: Blob): Promise<string> {
  const url = await new Promise<string>((resolve, reject) => {
    const lecteur = new FileReader();
    lecteur.onload = () => resolve(String(lecteur.result ?? ""));
    lecteur.onerror = () => reject(lecteur.error ?? new Error("lecture audio impossible"));
    lecteur.readAsDataURL(blob);
  });
  const virgule = url.indexOf(",");
  return virgule >= 0 ? url.slice(virgule + 1) : url;
}

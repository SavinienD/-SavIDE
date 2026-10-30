/**
 * axe:voix — enregistrement du micro dans la WebView (getUserMedia + MediaRecorder,
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

export function messageErreurMicro(type: ErreurMicro): string {
  switch (type) {
    case "non-supporte":
      return "Enregistrement audio indisponible dans cette fenêtre.";
    case "refuse":
      return "Micro refusé. Autorisez-le (invite de l'appli, ou Paramètres Windows > Confidentialité > Microphone > « Autoriser les applications de bureau »).";
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
  // axe:0.1.75 — PCM pour la dictée en direct (morceaux WAV de ≈ 3 s).
  private processeur: ScriptProcessorNode | null = null;
  private pcm: Float32Array[] = [];
  private pcmLongueur = 0;
  private dernierSon = 0;
  private frequence = 48_000;

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
            let somme = 0;
            for (let i = 0; i < canal.length; i += 1) somme += canal[i] * canal[i];
            if (Math.sqrt(somme / canal.length) > 0.012) this.dernierSon = performance.now();
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

  directPossible(): boolean {
    return this.processeur !== null;
  }

  /** Prend le son capté depuis la dernière coupe (fréquence du micro). */
  prendrePcm(): { echantillons: Float32Array; frequence: number } {
    const sortie = new Float32Array(this.pcmLongueur);
    let pos = 0;
    for (const bloc of this.pcm) {
      sortie.set(bloc, pos);
      pos += bloc.length;
    }
    this.pcm = [];
    this.pcmLongueur = 0;
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
    const contexte = this.contexte;
    this.contexte = null;
    this.analyseur = null;
    this.tampon = null;
    if (contexte) void contexte.close().catch(() => undefined);
  }
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

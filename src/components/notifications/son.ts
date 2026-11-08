// Son court des notifications, synthétisé (WebAudio) : aucun fichier, aucun
// paquet. Le navigateur n'autorise le son qu'après un geste de l'utilisateur : le contexte audio
// est préparé au premier clic ou à la première touche.
let contexte: AudioContext | null = null;

function obtenir(): AudioContext | null {
  try {
    const Classe = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
      | typeof AudioContext
      | undefined;
    if (!Classe) return null;
    contexte ??= new Classe();
    return contexte;
  } catch {
    return null;
  }
}

/** Prépare le son au premier geste de l'utilisateur ; rend la fonction qui retire l'écoute. */
export function armerSon(cible: Window = window): () => void {
  const armer = () => {
    const c = obtenir();
    if (c?.state === "suspended") void c.resume().catch(() => undefined);
    retirer();
  };
  const retirer = () => {
    cible.removeEventListener("pointerdown", armer, true);
    cible.removeEventListener("keydown", armer, true);
  };
  cible.addEventListener("pointerdown", armer, true);
  cible.addEventListener("keydown", armer, true);
  return retirer;
}

/** Notes (Hz) de chaque genre : deux notes qui montent (fini), trois brèves (attend votre
 *  réponse), deux qui descendent (échec). */
export function notesDe(genre: string): number[] {
  if (genre === "attente") return [880, 880, 1175];
  if (genre === "echec") return [660, 440];
  return [784, 1175];
}

/** Joue le son court du genre (environ 0,3 s, volume bas). */
export function jouerSon(genre: string): void {
  const c = obtenir();
  if (!c) return;
  if (c.state === "suspended") void c.resume().catch(() => undefined);
  const debut = c.currentTime + 0.01;
  notesDe(genre).forEach((frequence, i) => {
    const t = debut + i * 0.11;
    const oscillateur = c.createOscillator();
    const volume = c.createGain();
    oscillateur.type = "sine";
    oscillateur.frequency.setValueAtTime(frequence, t);
    volume.gain.setValueAtTime(0.0001, t);
    volume.gain.exponentialRampToValueAtTime(0.08, t + 0.012);
    volume.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    oscillateur.connect(volume).connect(c.destination);
    oscillateur.start(t);
    oscillateur.stop(t + 0.18);
  });
}

// axe:micro-local — enregistrement -> PCM mono 16 kHz (float 32 bits LE) pour
// whisper.cpp embarqué : le décodage se fait dans la vue web, pas en Rust.

export const MIME_PCM = "audio/pcm-f32-16k";
export const FREQUENCE = 16_000;

/** Échantillons float -> base64 (little-endian, quel que soit le poste). */
export function pcmEnBase64(echantillons: Float32Array): string {
  const vue = new DataView(new ArrayBuffer(echantillons.length * 4));
  for (let i = 0; i < echantillons.length; i += 1) vue.setFloat32(i * 4, echantillons[i], true);
  const octets = new Uint8Array(vue.buffer);
  let binaire = "";
  const pas = 0x8000;
  for (let i = 0; i < octets.length; i += pas) {
    binaire += String.fromCharCode(...octets.subarray(i, i + pas));
  }
  return btoa(binaire);
}

/** Décode l'enregistrement (webm/opus, mp4…) et le rééchantillonne en mono 16 kHz. */
export async function blobEnPcm16k(blob: Blob): Promise<Float32Array> {
  const donnees = await blob.arrayBuffer();
  const Ctx = (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
  const ctx = new Ctx();
  let audio: AudioBuffer;
  try {
    audio = await ctx.decodeAudioData(donnees);
  } finally {
    void ctx.close().catch(() => undefined);
  }
  const longueur = Math.max(1, Math.ceil(audio.duration * FREQUENCE));
  const hors = new OfflineAudioContext(1, longueur, FREQUENCE);
  const source = hors.createBufferSource();
  source.buffer = audio;
  source.connect(hors.destination);
  source.start();
  const rendu = await hors.startRendering();
  return rendu.getChannelData(0);
}

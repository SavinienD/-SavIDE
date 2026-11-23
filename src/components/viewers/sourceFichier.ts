// lecture et écriture binaires d'un fichier ouvert dans une visionneuse, sur le PC
// (commandes viewer_read_bytes / viewer_write_bytes) ou dans un espace cloud axe-cloud://
// (méthodes fs.read_bytes / fs.write_bytes du service, par morceaux en base64).

import { invoke } from "@tauri-apps/api/core";
import { cloudConnectionFromPath, cloudRpc, cloudToService } from "../../lib/ipc";
import { CHUNK_BYTES, readBytes } from "./bytes";

export type SourceFichier = {
  /** Chemin absolu (PC) ou virtuel (espace cloud). */
  chemin: string;
  nom: string;
  taille: number;
  /** Dossier de l'espace (local ou axe-cloud://…) et chemin relatif, pour les espaces cloud. */
  espace?: string;
  relatif?: string;
};

const MORCEAU_CLOUD = 3 * 1024 * 1024;

function connexion(src: SourceFichier): string | null {
  return src.espace ? cloudConnectionFromPath(src.espace) : null;
}

export function estCloud(src: SourceFichier): boolean {
  return Boolean(connexion(src) && src.relatif);
}

export function versBase64(octets: Uint8Array): string {
  let b = "";
  for (let i = 0; i < octets.length; i += 0x8000) b += String.fromCharCode(...octets.subarray(i, i + 0x8000));
  return btoa(b);
}

export function deBase64(texte: string): Uint8Array {
  const b = atob(texte);
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i += 1) out[i] = b.charCodeAt(i);
  return out;
}

/** Contenu entier du fichier (refusé au-delà de `max` octets). */
export async function lireTout(src: SourceFichier, max: number): Promise<Uint8Array> {
  const conn = connexion(src);
  const morceaux: Uint8Array[] = [];
  if (!conn || !src.espace || !src.relatif) {
    // Taille relue au fil de la lecture : celle de l'onglet peut dater d'avant un enregistrement.
    let total = 0;
    for (;;) {
      const m = await readBytes(src.chemin, total, CHUNK_BYTES);
      if (m.length) morceaux.push(m);
      total += m.length;
      if (total > max) throw new Error("Fichier trop volumineux pour cette visionneuse.");
      if (m.length < CHUNK_BYTES) break;
    }
    return concatener(morceaux, total);
  }
  const chemin = cloudToService(src.espace, src.relatif);
  let lu = 0;
  let taille = Infinity;
  while (lu < taille) {
    const r = await cloudRpc<{ data: string; size: number }>(conn, "fs.read_bytes", { path: chemin, offset: lu, length: MORCEAU_CLOUD });
    taille = r.size;
    if (taille > max) throw new Error("Fichier trop volumineux pour cette visionneuse.");
    const m = deBase64(r.data);
    if (!m.length) break;
    morceaux.push(m);
    lu += m.length;
  }
  return concatener(morceaux, lu);
}

function concatener(morceaux: Uint8Array[], total: number): Uint8Array {
  if (morceaux.length === 1) return morceaux[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const m of morceaux) {
    out.set(m, o);
    o += m.length;
  }
  return out;
}

/** Remplace (ou crée) le fichier. */
export async function ecrireTout(src: SourceFichier, octets: Uint8Array, creerSeulement = false): Promise<void> {
  const conn = connexion(src);
  if (!conn || !src.espace || !src.relatif) {
    await invoke<number>("viewer_write_bytes", { input: { path: src.chemin, data: versBase64(octets), createOnly: creerSeulement } });
    return;
  }
  if (creerSeulement && (await existe(src))) throw new Error(`${src.nom} existe déjà`);
  const chemin = cloudToService(src.espace, src.relatif);
  for (let o = 0; o === 0 || o < octets.length; o += MORCEAU_CLOUD) {
    const fin = Math.min(octets.length, o + MORCEAU_CLOUD);
    await cloudRpc(conn, "fs.write_bytes", {
      path: chemin,
      data: versBase64(octets.subarray(o, fin)),
      append: o > 0,
      notify: fin >= octets.length,
    });
    if (fin >= octets.length) break;
  }
}

/** Le fichier existe-t-il ? */
export async function existe(src: SourceFichier): Promise<boolean> {
  const conn = connexion(src);
  try {
    if (conn && src.espace && src.relatif) {
      await cloudRpc(conn, "fs.read_bytes", { path: cloudToService(src.espace, src.relatif), offset: 0, length: 0 });
    } else {
      await invoke("viewer_read_bytes", { input: { path: src.chemin, offset: 0, length: 0 } });
    }
    return true;
  } catch {
    return false;
  }
}

/** Fichier voisin (même dossier) nommé `nom`. */
export function voisin(src: SourceFichier, nom: string): SourceFichier {
  const remplacer = (p: string) => p.replace(/[^\\/]*$/, nom);
  return {
    chemin: remplacer(src.chemin),
    nom,
    taille: 0,
    espace: src.espace,
    relatif: src.relatif !== undefined ? remplacer(src.relatif) : undefined,
  };
}

/** Nom de « copie » libre : « rapport (copie).docx », « rapport (copie 2).docx »… */
export async function nomCopieLibre(src: SourceFichier, extension: string): Promise<SourceFichier> {
  const tige = src.nom.replace(/\.[^.]*$/, "");
  for (let i = 1; i < 100; i += 1) {
    const nom = `${tige} (copie${i > 1 ? ` ${i}` : ""}).${extension}`;
    const v = voisin(src, nom);
    if (!(await existe(v))) return v;
  }
  return voisin(src, `${tige} (copie ${Date.now()}).${extension}`);
}

/** Nom de fichier libre pour `tige.extension` (« tige (2).docx » si déjà pris). */
export async function nomLibre(src: SourceFichier, tige: string, extension: string): Promise<SourceFichier> {
  for (let i = 1; i < 100; i += 1) {
    const v = voisin(src, `${tige}${i > 1 ? ` (${i})` : ""}.${extension}`);
    if (!(await existe(v))) return v;
  }
  return voisin(src, `${tige} (${Date.now()}).${extension}`);
}

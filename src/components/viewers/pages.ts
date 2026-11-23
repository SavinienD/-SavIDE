// lecture des documents Apple Pages (.pages), sans dépendance au système.
//
// Un .pages récent (2013 et après) est un zip : QuickLook/Preview.pdf (aperçu fidèle, pas
// toujours présent), preview.jpg (vignette) et Index/*.iwa (le document : flux « snappy »
// à la façon d'Apple, sans CRC, puis messages protobuf). Le texte du corps est dans les
// messages TSWP.StorageArchive (champ 3 : texte, champ 1 : genre, 0 = corps).
// Un .pages ancien (Pages '09) contient index.xml (ou index.xml.gz) : texte dans <sf:p>.
// Tout ici est pur (aucun appel à Tauri) : testé par tests/pages.test.cjs.

/** Lit un entier « varint » protobuf ; renvoie [valeur, position suivante]. */
export function lireVarint(octets: Uint8Array, pos: number): [number, number] {
  let valeur = 0;
  let mult = 1;
  for (let i = 0; i < 10; i += 1) {
    if (pos >= octets.length) throw new Error("varint tronqué");
    const b = octets[pos++];
    valeur += (b & 0x7f) * mult;
    if (b < 0x80) return [valeur, pos];
    mult *= 128;
  }
  throw new Error("varint trop long");
}

/** Décompresse un bloc snappy « brut » (préambule = taille décompressée). */
export function snappyBrut(src: Uint8Array): Uint8Array {
  const [taille, debut] = lireVarint(src, 0);
  if (taille > 512 * 1024 * 1024) throw new Error("bloc snappy trop grand");
  const out = new Uint8Array(taille);
  let o = 0;
  let p = debut;
  while (p < src.length) {
    const tag = src[p++];
    const genre = tag & 3;
    if (genre === 0) {
      let long = tag >> 2;
      if (long >= 60) {
        const n = long - 59;
        long = 0;
        for (let i = 0; i < n; i += 1) long |= src[p + i] << (8 * i);
        long >>>= 0;
        p += n;
      }
      long += 1;
      if (p + long > src.length || o + long > taille) throw new Error("littéral snappy hors limites");
      out.set(src.subarray(p, p + long), o);
      p += long;
      o += long;
      continue;
    }
    let long: number;
    let decalage: number;
    if (genre === 1) {
      long = ((tag >> 2) & 7) + 4;
      decalage = ((tag >> 5) << 8) | src[p++];
    } else if (genre === 2) {
      long = (tag >> 2) + 1;
      decalage = src[p] | (src[p + 1] << 8);
      p += 2;
    } else {
      long = (tag >> 2) + 1;
      decalage = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
      p += 4;
    }
    if (decalage === 0 || decalage > o || o + long > taille) throw new Error("copie snappy invalide");
    // Copie octet par octet : la source peut chevaucher la destination.
    for (let i = 0; i < long; i += 1) out[o + i] = out[o - decalage + i];
    o += long;
  }
  if (o !== taille) throw new Error("bloc snappy incomplet");
  return out;
}

/** Décompresse un fichier .iwa : suite de morceaux [type 0][taille sur 3 octets][snappy brut]. */
export function decompresserIwa(src: Uint8Array): Uint8Array {
  const morceaux: Uint8Array[] = [];
  let p = 0;
  let total = 0;
  while (p + 4 <= src.length) {
    const type = src[p];
    const long = src[p + 1] | (src[p + 2] << 8) | (src[p + 3] << 16);
    p += 4;
    if (p + long > src.length) throw new Error("morceau .iwa tronqué");
    const bloc = src.subarray(p, p + long);
    p += long;
    const clair = type === 0 ? snappyBrut(bloc) : bloc;
    morceaux.push(clair);
    total += clair.length;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const m of morceaux) {
    out.set(m, o);
    o += m.length;
  }
  return out;
}

export type ChampProto = { numero: number; type: number; valeur: number; octets?: Uint8Array };

/** Découpe un message protobuf en champs (sans schéma). Lève une erreur s'il est mal formé. */
export function champsProto(msg: Uint8Array): ChampProto[] {
  const champs: ChampProto[] = [];
  let p = 0;
  while (p < msg.length) {
    const [cle, apres] = lireVarint(msg, p);
    p = apres;
    const numero = Math.floor(cle / 8);
    const type = cle % 8;
    if (numero === 0) throw new Error("champ protobuf 0");
    if (type === 0) {
      const [v, q] = lireVarint(msg, p);
      champs.push({ numero, type, valeur: v });
      p = q;
    } else if (type === 1) {
      p += 8;
      champs.push({ numero, type, valeur: 0 });
    } else if (type === 5) {
      p += 4;
      champs.push({ numero, type, valeur: 0 });
    } else if (type === 2) {
      const [long, q] = lireVarint(msg, p);
      if (q + long > msg.length) throw new Error("champ protobuf tronqué");
      champs.push({ numero, type, valeur: long, octets: msg.subarray(q, q + long) });
      p = q + long;
    } else {
      throw new Error(`type protobuf ${type} non géré`);
    }
    if (p > msg.length) throw new Error("message protobuf tronqué");
  }
  return champs;
}

export type MessageIwa = { identifiant: number; type: number; donnees: Uint8Array };

/** Lit les archives d'un flux .iwa décompressé : [varint taille][ArchiveInfo][messages…]. */
export function messagesIwa(flux: Uint8Array): MessageIwa[] {
  const out: MessageIwa[] = [];
  let p = 0;
  while (p < flux.length) {
    const [long, q] = lireVarint(flux, p);
    if (q + long > flux.length) throw new Error("ArchiveInfo tronqué");
    const info = champsProto(flux.subarray(q, q + long));
    p = q + long;
    const identifiant = info.find((c) => c.numero === 1 && c.type === 0)?.valeur ?? 0;
    for (const c of info) {
      if (c.numero !== 2 || !c.octets) continue;
      const mi = champsProto(c.octets);
      const type = mi.find((x) => x.numero === 1 && x.type === 0)?.valeur ?? 0;
      const taille = mi.find((x) => x.numero === 3 && x.type === 0)?.valeur ?? 0;
      if (p + taille > flux.length) throw new Error("message .iwa tronqué");
      out.push({ identifiant, type, donnees: flux.subarray(p, p + taille) });
      p += taille;
    }
  }
  return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function texteUtf8(octets: Uint8Array): string | null {
  try {
    return UTF8.decode(octets);
  } catch {
    return null;
  }
}

/** Genres de TSWP.StorageArchive (champ 1). */
const GENRE_CORPS = 0;
const GENRES_ENTETE = new Set([1]);
/** Types de messages connus pour TSWP.StorageArchive selon les versions de Pages. */
const TYPES_STOCKAGE = new Set([2001, 2005]);

/** Nettoie un texte TSWP et le coupe en paragraphes. */
export function paragraphesTswp(texte: string): string[] {
  return texte
    .split(/\u2029|\u2028|\r\n|\r|\n/)
    .map((p) =>
      p
        .replace(/[\ufffc\u0000-\u0008\u000b\u000c\u000e-\u001f\u0004]/g, "")
        .replace(/\s+$/u, ""),
    )
    .filter((p, i, tous) => p.length > 0 || (i > 0 && tous[i - 1].length > 0));
}

export type TextesIwa = { corps: string[]; autres: string[]; heuristique: boolean };

/** Textes d'un ou plusieurs flux .iwa décompressés (Document.iwa d'abord). */
export function textesIwa(flux: Uint8Array[]): TextesIwa {
  const corps: string[] = [];
  const autres: string[] = [];
  for (const f of flux) {
    let messages: MessageIwa[];
    try {
      messages = messagesIwa(f);
    } catch {
      continue;
    }
    for (const m of messages) {
      if (!TYPES_STOCKAGE.has(m.type)) continue;
      let champs: ChampProto[];
      try {
        champs = champsProto(m.donnees);
      } catch {
        continue;
      }
      const genre = champs.find((c) => c.numero === 1 && c.type === 0)?.valeur ?? GENRE_CORPS;
      const textes = champs
        .filter((c) => c.numero === 3 && c.octets)
        .map((c) => texteUtf8(c.octets!))
        .filter((t): t is string => t !== null);
      if (!textes.length) continue;
      const paras = paragraphesTswp(textes.join(""));
      if (!paras.some((p) => p.trim())) continue;
      if (genre === GENRE_CORPS) corps.push(...paras);
      else if (!GENRES_ENTETE.has(genre)) autres.push(...paras);
    }
  }
  if (corps.length || autres.length) return { corps: nettoyer(corps), autres: nettoyer(autres), heuristique: false };
  // Secours : chaînes lisibles de tous les messages (format inconnu).
  const vues = new Set<string>();
  const chaines: string[] = [];
  const parcourir = (msg: Uint8Array, profondeur: number) => {
    let champs: ChampProto[];
    try {
      champs = champsProto(msg);
    } catch {
      return false;
    }
    for (const c of champs) {
      if (!c.octets || !c.octets.length) continue;
      if (profondeur < 6 && parcourir(c.octets, profondeur + 1)) continue;
      const t = texteUtf8(c.octets);
      if (t && /\p{L}.*\p{L}/su.test(t) && !/[\u0000-\u0008\u000e-\u001f]/.test(t) && !vues.has(t)) {
        vues.add(t);
        chaines.push(...paragraphesTswp(t));
      }
    }
    return true;
  };
  for (const f of flux) {
    try {
      for (const m of messagesIwa(f)) parcourir(m.donnees, 0);
    } catch {
      /* flux illisible : ignoré */
    }
  }
  return { corps: nettoyer(chaines), autres: [], heuristique: true };
}

function nettoyer(paras: string[]): string[] {
  const out = [...paras];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  while (out.length && !out[0].trim()) out.shift();
  return out;
}

const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

function decoderEntites(t: string): string {
  return t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (tout, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : tout;
    }
    return ENTITES[e.toLowerCase()] ?? tout;
  });
}

/** Paragraphes d'un index.xml de Pages '09 (et avant) : <sf:p> du corps (sf:text-body). */
export function textesXmlAncien(xml: string): string[] {
  const debut = xml.search(/<sf:text-body[\s>]/);
  const zone = debut >= 0 ? xml.slice(debut, xml.indexOf("</sf:text-body>", debut) + 1 || undefined) : xml;
  const paras: string[] = [];
  const re = /<sf:p(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/sf:p>)/g;
  for (let m = re.exec(zone); m; m = re.exec(zone)) {
    const brut = (m[1] ?? "")
      .replace(/<sf:tab\s*\/>/g, "\t")
      .replace(/<sf:(?:br|lnbr|crbr|pgbr|sectbr)\s*\/>/g, "\n")
      .replace(/<sf:(?:footnotes|attachments|annotations)[\s\S]*?<\/sf:\w+>/g, "")
      .replace(/<[^>]+>/g, "");
    paras.push(decoderEntites(brut).replace(/\s+$/u, ""));
  }
  return nettoyer(paras.filter((p, i, t) => p.length > 0 || (i > 0 && t[i - 1].length > 0)));
}

/** Décompresse du gzip (DecompressionStream : navigateurs récents et Node 18+). */
export async function gunzip(octets: Uint8Array): Promise<Uint8Array> {
  const flux = new Blob([octets as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(flux).arrayBuffer());
}

/** Accès aux entrées d'un .pages (zip ou dossier paquet). */
export type EntreesPages = {
  noms: string[];
  lire: (nom: string) => Promise<Uint8Array>;
};

export type ResultatPages = {
  format: "iwa" | "xml-ancien" | "inconnu";
  /** QuickLook/Preview.pdf (aperçu fidèle). */
  apercuPdf: Uint8Array | null;
  /** Vignette (preview.jpg, QuickLook/Thumbnail.jpg…) : nom d'entrée et octets. */
  vignette: { nom: string; octets: Uint8Array } | null;
  /** Paragraphes du corps, dans l'ordre. */
  paragraphes: string[];
  /** Autres textes (zones de texte, notes, cellules). */
  autres: string[];
  /** Le texte vient d'une lecture approximative (structure non reconnue). */
  approximatif: boolean;
};

const VIGNETTES = ["preview.jpg", "QuickLook/Thumbnail.jpg", "preview-web.jpg", "QuickLook/Thumbnail.png", "preview-micro.jpg"];

function trouver(noms: string[], cible: string): string | undefined {
  const bas = cible.toLowerCase();
  return noms.find((n) => n.replace(/^\/+/, "").toLowerCase() === bas);
}

/** Analyse un document Pages. `avecTexte: false` s'arrête à l'aperçu PDF quand il existe. */
export async function lirePages(entrees: EntreesPages, avecTexte = true): Promise<ResultatPages> {
  const { noms } = entrees;
  const res: ResultatPages = { format: "inconnu", apercuPdf: null, vignette: null, paragraphes: [], autres: [], approximatif: false };
  const pdf = trouver(noms, "QuickLook/Preview.pdf");
  if (pdf) res.apercuPdf = await entrees.lire(pdf);
  for (const v of VIGNETTES) {
    const nom = trouver(noms, v);
    if (nom) {
      res.vignette = { nom, octets: await entrees.lire(nom) };
      break;
    }
  }
  const iwa = noms.filter((n) => /(^|\/)Index\/.+\.iwa$/i.test(n));
  const xml = trouver(noms, "index.xml") ?? trouver(noms, "index.xml.gz");
  if (iwa.length) res.format = "iwa";
  else if (xml) res.format = "xml-ancien";
  if (!avecTexte && res.apercuPdf) return res;
  if (res.format === "iwa") {
    const ordre = [...iwa].sort((a, b) => rang(a) - rang(b) || a.localeCompare(b));
    const flux: Uint8Array[] = [];
    for (const nom of ordre) {
      try {
        flux.push(decompresserIwa(await entrees.lire(nom)));
      } catch {
        /* entrée illisible : ignorée */
      }
    }
    const t = textesIwa(flux);
    res.paragraphes = t.corps;
    res.autres = t.autres;
    res.approximatif = t.heuristique;
  } else if (res.format === "xml-ancien" && xml) {
    let octets = await entrees.lire(xml);
    if (/\.gz$/i.test(xml) || (octets[0] === 0x1f && octets[1] === 0x8b)) octets = await gunzip(octets);
    res.paragraphes = textesXmlAncien(new TextDecoder("utf-8").decode(octets));
  }
  return res;
}

function rang(nom: string): number {
  if (/\/Document\.iwa$/i.test(nom)) return 0;
  if (/\/DocumentStylesheet|\/ViewState|\/Metadata|\/AnnotationAuthorStorage|\/CalculationEngine/i.test(nom)) return 3;
  return 1;
}

/** Texte brut (paragraphes séparés par une ligne vide pour l'aperçu, \n pour l'éditeur). */
export function texteDePages(res: Pick<ResultatPages, "paragraphes" | "autres">): string {
  return [...res.paragraphes, ...(res.autres.length ? ["", ...res.autres] : [])].join("\n");
}

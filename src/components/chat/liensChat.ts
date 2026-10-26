// axe:liens — découpe d'un texte de chat en liens cliquables : URL http(s), chemins de
// fichiers (relatifs, absolus POSIX, Windows « C:\… » ou « dossier\fichier.ext »), le reste en texte.
// Module pur (sans React) : testé par tests/liensChat.test.cjs.

export type GenreLien = "texte" | "url" | "fichier";
export type SegmentLien = { genre: GenreLien; texte: string };

const EXT =
  "(?:tsx?|jsx?|rs|toml|json|md|css|scss|html|ya?ml|lock|sh|zsh|bash|ps1|py|go|java|kt|swift|sql|env|mjs|cjs|config|txt|csv|log|xml|ini|conf)";
const SEG = "[A-Za-z0-9_.+@-]+";
const LIGNE = "(?::\\d+(?::\\d+)?)?";
const URL = "https?:\\/\\/[^\\s<>\"'`]+";
const WIN_ABS = `[A-Za-z]:[\\\\/](?:${SEG}[\\\\/])*${SEG}\\.[A-Za-z0-9]+${LIGNE}`;
const WIN_REL = `(?:\\.{1,2}\\\\)?(?:${SEG}\\\\)+${SEG}\\.[A-Za-z0-9]+${LIGNE}`;
const POSIX = `(?:~\\/|\\.{1,2}\\/|\\/)?(?:${SEG}\\/)+${SEG}\\.[A-Za-z0-9]+${LIGNE}`;
const NU = `${SEG}\\.${EXT}(?![A-Za-z0-9_])${LIGNE}`;

// L'URL passe en premier : « https://exemple.fr/a/b.html » ne devient pas un chemin.
const MOTIF = new RegExp(`(${URL})|(${WIN_ABS}|${WIN_REL}|${POSIX}|${NU})`, "g");

/** Retire la ponctuation finale d'une URL (« voir https://x.fr/a. ») ; garde « ) » s'il est apparié. */
export function nettoyerUrl(url: string): string {
  let u = url;
  for (;;) {
    const fin = u.slice(-1);
    if (/[.,;:!?'"»]/.test(fin)) u = u.slice(0, -1);
    else if (fin === ")" && (u.match(/\(/g)?.length ?? 0) < (u.match(/\)/g)?.length ?? 0)) u = u.slice(0, -1);
    else return u;
  }
}

export function decouperLiens(texte: string): SegmentLien[] {
  const out: SegmentLien[] = [];
  let dernier = 0;
  const pousserTexte = (t: string) => {
    if (!t) return;
    const prec = out[out.length - 1];
    if (prec?.genre === "texte") prec.texte += t;
    else out.push({ genre: "texte", texte: t });
  };
  MOTIF.lastIndex = 0;
  for (const m of texte.matchAll(MOTIF)) {
    const i = m.index ?? 0;
    const avant = i > 0 ? texte[i - 1] : "";
    // Pas de lien au milieu d'un mot (« abc/def.ts » collé à une lettre est déjà inclus ; « x@a.md » non).
    if (avant && /[A-Za-z0-9_@]/.test(avant)) continue;
    let valeur = m[0];
    const genre: GenreLien = m[1] ? "url" : "fichier";
    if (genre === "url") valeur = nettoyerUrl(valeur);
    if (genre === "fichier" && valeur.includes("@") && !/[\\/]/.test(valeur)) continue;
    if (genre === "url" && valeur.length <= "https://".length) continue;
    pousserTexte(texte.slice(dernier, i));
    out.push({ genre, texte: valeur });
    dernier = i + valeur.length;
  }
  pousserTexte(texte.slice(dernier));
  return out;
}

export function estFichier(valeur: string): boolean {
  const s = decouperLiens(valeur.trim());
  return s.length === 1 && s[0].genre === "fichier";
}

export function estUrl(valeur: string): boolean {
  return /^https?:\/\//i.test(valeur.trim());
}

/** Libellé raccourci d'une URL nue : sans « https:// » ni « www. », coupé au milieu si long. */
export function raccourcirUrl(url: string, max = 60): string {
  let t = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "");
  if (t.length > max) {
    const tete = Math.ceil((max - 1) * 0.6);
    t = `${t.slice(0, tete)}…${t.slice(t.length - (max - 1 - tete))}`;
  }
  return t;
}

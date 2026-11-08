// Outils du terminal : recherche dans l'historique, copie de toute la sortie, chemin d'un
// fichier glissé de l'explorateur. Logique pure (tests/outilsTerminal.test.cjs).

export type Occurrence = { ligne: number; colonne: number; longueur: number };

/** Occurrences de `motif` (texte, pas une expression), ligne par ligne, sans chevauchement. */
export function chercherDansLignes(lignes: string[], motif: string, casse = false): Occurrence[] {
  if (!motif) return [];
  const cherche = casse ? motif : motif.toLocaleLowerCase();
  const sortie: Occurrence[] = [];
  lignes.forEach((brute, ligne) => {
    const texte = casse ? brute : brute.toLocaleLowerCase();
    let i = texte.indexOf(cherche);
    while (i >= 0) {
      sortie.push({ ligne, colonne: i, longueur: motif.length });
      i = texte.indexOf(cherche, i + cherche.length);
    }
  });
  return sortie;
}

/** Indice de l'occurrence suivante (sens 1) ou précédente (-1), en boucle ; -1 sans occurrence. */
export function occurrenceVoisine(nombre: number, courant: number, sens: 1 | -1): number {
  if (nombre <= 0) return -1;
  if (courant < 0) return sens === 1 ? 0 : nombre - 1;
  return (courant + sens + nombre) % nombre;
}

/** Toute la sortie : espaces de fin de ligne et lignes vides finales retirés. */
export function texteComplet(lignes: string[]): string {
  const propres = lignes.map((l) => l.replace(/\s+$/, ""));
  while (propres.length && !propres[propres.length - 1]) propres.pop();
  return propres.join("\n");
}

/** Chemin prêt à taper dans un shell : entre guillemets ; sous WSL, C:\… devient /mnt/c/…. */
export function cheminPourTerminal(chemin: string, options: { wsl: boolean }): string {
  let c = chemin;
  const lecteur = /^([a-zA-Z]):[\\/](.*)$/.exec(c);
  if (options.wsl && lecteur) c = `/mnt/${lecteur[1].toLowerCase()}/${lecteur[2].replace(/\\/g, "/")}`;
  if (!c.includes('"')) return `"${c}"`;
  return `'${c.replace(/'/g, "'\\''")}'`;
}

type EntreeGlissee = { absolutePath: string; relativePath: string };

/** Chemins des fichiers glissés, séparés par des espaces (et un espace final, prêt à taper la
 *  suite). Agent dans un arbre de travail : le même fichier relatif, dans son dossier. */
export function cheminsDeposes(entrees: EntreeGlissee[], agent: { dossier: string; branche?: string } | null, wsl: boolean): string {
  return entrees
    .map((e) => {
      if (!agent?.branche || !e.relativePath) return e.absolutePath;
      const sep = agent.dossier.includes("\\") ? "\\" : "/";
      return `${agent.dossier.replace(/[\\/]+$/, "")}${sep}${e.relativePath.split(/[\\/]/).join(sep)}`;
    })
    .map((c) => `${cheminPourTerminal(c, { wsl })} `)
    .join("");
}

/** Entrées glissées depuis l'explorateur (types MIME de FileTree.tsx), sinon []. */
export function entreesGlissees(donnees: DataTransfer): EntreeGlissee[] {
  const valides = (liste: unknown[]): EntreeGlissee[] =>
    liste.filter((e): e is EntreeGlissee => !!e && typeof (e as EntreeGlissee).absolutePath === "string").map((e) => ({
      absolutePath: e.absolutePath,
      relativePath: typeof e.relativePath === "string" ? e.relativePath : "",
    }));
  try {
    const brut = donnees.getData("application/x-axecode-files");
    if (brut) {
      const p = JSON.parse(brut) as { entries?: unknown[] };
      if (Array.isArray(p.entries)) return valides(p.entries);
    }
    const ancien = donnees.getData("application/x-axecode-file");
    if (ancien) return valides([JSON.parse(ancien)]);
  } catch {
    /* données illisibles */
  }
  return [];
}

/** Vrai si l'élément glissé vient de l'explorateur de fichiers. */
export function glisseDepuisExplorateur(donnees: DataTransfer): boolean {
  const types = Array.from(donnees.types ?? []);
  return types.includes("application/x-axecode-files") || types.includes("application/x-axecode-file");
}

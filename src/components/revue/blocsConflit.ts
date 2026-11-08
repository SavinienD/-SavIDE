// Revue des changements : blocs de conflit d'un fichier (marqueurs <<<<<<< ||||||| ======= >>>>>>>)
// et choix « la nôtre / la leur / les deux ». Module pur (testé par tests/revueConflits.test.cjs).

export type BlocConflit = {
  /** Lignes du marqueur d'ouverture et de fermeture (1 = première ligne). */
  debut: number;
  fin: number;
  nous: string[];
  base: string[] | null;
  eux: string[];
  etiquetteNous: string;
  etiquetteEux: string;
};

export type ChoixConflit = "nous" | "eux" | "deux";

const OUVRE = /^<{7}(?: (.*))?$/;
const BASE = /^\|{7}(?: .*)?$/;
const SEPARE = /^={7}$/;
const FERME = /^>{7}(?: (.*))?$/;

function lignes(texte: string): { lignes: string[]; fin: string } {
  const fin = texte.includes("\r\n") ? "\r\n" : "\n";
  return { lignes: texte.split(/\r?\n/), fin };
}

/** Blocs de conflit, dans l'ordre ; un bloc mal fermé est ignoré. */
export function blocsDeConflit(texte: string): BlocConflit[] {
  const { lignes: l } = lignes(texte);
  const blocs: BlocConflit[] = [];
  let i = 0;
  while (i < l.length) {
    const ouvre = OUVRE.exec(l[i]);
    if (!ouvre) {
      i += 1;
      continue;
    }
    const debut = i;
    const nous: string[] = [];
    let base: string[] | null = null;
    const eux: string[] = [];
    let zone: "nous" | "base" | "eux" = "nous";
    let j = i + 1;
    let ferme: RegExpExecArray | null = null;
    for (; j < l.length; j += 1) {
      if (zone !== "eux" && BASE.test(l[j]) && zone === "nous") {
        zone = "base";
        base = [];
        continue;
      }
      if (zone !== "eux" && SEPARE.test(l[j])) {
        zone = "eux";
        continue;
      }
      if (zone === "eux" && (ferme = FERME.exec(l[j]))) break;
      if (OUVRE.test(l[j])) break; // nouveau bloc avant la fermeture : celui-ci est abîmé
      (zone === "nous" ? nous : zone === "base" ? (base as string[]) : eux).push(l[j]);
    }
    if (ferme && zone === "eux") {
      blocs.push({ debut: debut + 1, fin: j + 1, nous, base, eux, etiquetteNous: ouvre[1] ?? "", etiquetteEux: ferme[1] ?? "" });
      i = j + 1;
    } else {
      i = debut + 1;
    }
  }
  return blocs;
}

export function contenuChoisi(bloc: BlocConflit, choix: ChoixConflit): string[] {
  return choix === "nous" ? bloc.nous : choix === "eux" ? bloc.eux : [...bloc.nous, ...bloc.eux];
}

/** Texte avec le bloc n° `index` remplacé par la version choisie. */
export function choisirBloc(texte: string, index: number, choix: ChoixConflit): string {
  const bloc = blocsDeConflit(texte)[index];
  if (!bloc) return texte;
  const { lignes: l, fin } = lignes(texte);
  return [...l.slice(0, bloc.debut - 1), ...contenuChoisi(bloc, choix), ...l.slice(bloc.fin)].join(fin);
}

/** Bloc qui contient la ligne, sinon le premier bloc après elle, sinon -1. */
export function blocDeLigne(blocs: readonly BlocConflit[], ligne: number): number {
  const dedans = blocs.findIndex((b) => ligne >= b.debut && ligne <= b.fin);
  if (dedans >= 0) return dedans;
  return blocs.findIndex((b) => b.debut > ligne);
}

function cloture(lignesBloc: readonly string[]): string {
  const plusLongue = Math.max(0, ...lignesBloc.flatMap((x) => Array.from(x.matchAll(/`+/g), (m) => m[0].length)));
  return "`".repeat(Math.max(3, plusLongue + 1));
}

export type FichierEnConflit = { chemin: string; texte: string | null; code: string };

/** Message pour l'agent : chaque bloc en conflit avec les deux versions. */
export function messageConflits(
  titre: string,
  fichiers: readonly FichierEnConflit[],
  nomNous: string,
  nomEux: string,
  langage: (fichier: string) => string = () => "",
): string {
  const parties: string[] = [
    `${titre} : ${fichiers.length} fichier${fichiers.length > 1 ? "s" : ""} en conflit. Résous ces conflits directement dans les fichiers (garde ce qui doit l'être des deux côtés et enlève les marqueurs), marque chaque fichier résolu avec git add, puis dis-moi ce que tu as choisi. Ne termine pas l'opération : je relirai avant de continuer.`,
  ];
  let n = 0;
  for (const f of fichiers) {
    const blocs = f.texte ? blocsDeConflit(f.texte) : [];
    if (!blocs.length) {
      n += 1;
      parties.push(`${n}. ${f.chemin} : conflit sur le fichier entier (code git ${f.code}).`);
      continue;
    }
    blocs.forEach((b, i) => {
      n += 1;
      const l = langage(f.chemin);
      const c = cloture([...b.nous, ...b.eux]);
      parties.push(
        [
          `${n}. ${f.chemin}:${b.debut}-${b.fin} (bloc ${i + 1} sur ${blocs.length})`,
          `Notre version (${nomNous}) :`,
          `${c}${l}\n${b.nous.join("\n")}\n${c}`,
          `La leur (${nomEux}) :`,
          `${c}${l}\n${b.eux.join("\n")}\n${c}`,
        ].join("\n"),
      );
    });
  }
  return parties.join("\n\n");
}

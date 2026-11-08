// Lot palette — Ctrl+P : ouvrir un fichier par son nom. Liste par `rg --files` (le .gitignore
// est respecté), recherche approximative, fichiers récents d'abord, dossier affiché à côté.
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { fileIcon } from "../../lib/fileIcon";
import { estMac } from "../../lib/plateforme";
import { classerFichiers, preparer } from "./flou";
import { Palette, type ElementPalette } from "./Palette";
import { fichiersEnCache, listerFichiers, type ListeFichiers } from "./paletteApi";
import { fichiersRecents } from "./recents";

type Props = {
  dossier: string;
  /** Ouvre le fichier (`autreColonne` : Ctrl+Entrée, à côté de la colonne active). */
  onOuvrir: (chemin: string, autreColonne: boolean) => void;
  onFermer: () => void;
};

const LIMITE = 60;

export function PaletteFichiers({ dossier, onOuvrir, onFermer }: Props) {
  const [requete, setRequete] = useState("");
  const [liste, setListe] = useState<ListeFichiers | null>(() => fichiersEnCache(dossier));
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => {
    let vivant = true;
    listerFichiers(dossier)
      .then((l) => vivant && setListe(l))
      .catch((e) => vivant && setErreur(e instanceof Error ? e.message : String(e)));
    return () => {
      vivant = false;
    };
  }, [dossier]);

  const prepares = useMemo(() => preparer(liste?.fichiers ?? []), [liste]);
  const recents = useMemo(() => fichiersRecents(dossier), [dossier]);
  const cherche = useDeferredValue(requete);
  const elements = useMemo<ElementPalette[]>(
    () =>
      classerFichiers(cherche, prepares, recents, LIMITE).map((c) => {
        const coupe = c.chemin.lastIndexOf("/") + 1;
        return {
          id: c.chemin,
          icone: fileIcon(c.chemin.slice(coupe)),
          titre: c.chemin.slice(coupe),
          marquesTitre: c.positions.filter((p) => p >= coupe).map((p) => p - coupe),
          detail: coupe > 1 ? c.chemin.slice(0, coupe - 1) : undefined,
          marquesDetail: c.positions.filter((p) => p < coupe - 1),
          indication: c.recent ? "récent" : undefined,
        };
      }),
    [cherche, prepares, recents],
  );

  const etat = erreur
    ? `Liste des fichiers impossible : ${erreur}`
    : !liste
      ? "Lecture des fichiers…"
      : !elements.length
        ? requete.trim()
          ? "Aucun fichier ne correspond"
          : "Aucun fichier dans ce dossier"
        : null;
  const ctrl = estMac() ? "⌘" : "Ctrl";
  return (
    <Palette
      titre="Ouvrir un fichier"
      genre="fichiers"
      placeholder="Nom du fichier"
      requete={requete}
      onRequete={setRequete}
      elements={elements}
      etat={etat}
      note={
        liste?.tronque
          ? `Liste limitée à ${liste.fichiers.length.toLocaleString("fr-FR")} fichiers`
          : liste?.source === "liste"
            ? "Liste sans le .gitignore (rg indisponible)"
            : null
      }
      aide={[
        { touches: "Entrée", action: "ouvrir" },
        { touches: `${ctrl}+Entrée`, action: "dans une autre colonne" },
        { touches: "Échap", action: "fermer" },
      ]}
      onChoisir={(el, { autreColonne }) => onOuvrir(el.id, autreColonne)}
      onFermer={onFermer}
    />
  );
}

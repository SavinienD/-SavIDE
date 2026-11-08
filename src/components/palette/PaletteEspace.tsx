// Lot palette — palettes d'un dossier ouvert : Ctrl+P (fichier par son nom). Montée une fois
// dans Workspace.tsx (une ligne d'accroche) ; tout le reste vit ici.
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fournirActions } from "../../axe/raccourcis";
import { trouver, type EtatColonnes } from "../chat/colonnes";
import type { WorkspaceEntry } from "../../types";
import { entreeFichier, versColonneVoisine } from "./ouvertureFichier";
import { PaletteFichiers } from "./PaletteFichiers";
import { noterFichierRecent } from "./recents";

type Props = {
  workspacePath: string;
  layout: "ide" | "chat";
  /** Fichier de l'onglet actif de l'éditeur (noté dans les récents). */
  fichierActif?: string | null;
  openFile?: (entry: WorkspaceEntry) => Promise<boolean>;
  disposition?: EtatColonnes<string>;
  setDisposition?: Dispatch<SetStateAction<EtatColonnes<string>>>;
};

type Ouverte = null | "fichiers";

export function PaletteEspace(props: Props) {
  const [ouverte, setOuverte] = useState<Ouverte>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // Ctrl+Entrée : fichier à passer dans la colonne voisine dès que l'éditeur l'a rangé.
  const enAttente = useRef<{ chemin: string; depuis: number } | null>(null);

  // Tout fichier activé (arbre, onglet, lien du chat, palette) passe en tête des récents.
  useEffect(() => {
    if (props.fichierActif) noterFichierRecent(props.workspacePath, props.fichierActif);
  }, [props.fichierActif, props.workspacePath]);

  useEffect(
    () =>
      fournirActions({
        // Sans éditeur (conversation sans dossier) : la touche est avalée (pas d'impression).
        ouvrirFichier: () => {
          if (propsRef.current.layout === "ide" && propsRef.current.openFile) setOuverte("fichiers");
        },
      }),
    [],
  );

  const deplacerSiRange = useCallback(() => {
    const attente = enAttente.current;
    const { disposition, setDisposition } = propsRef.current;
    if (!attente || !disposition || !setDisposition || !trouver(disposition.colonnes, attente.chemin)) return;
    enAttente.current = null;
    setDisposition((etat) => versColonneVoisine(etat, attente.chemin, attente.depuis));
  }, []);
  useEffect(deplacerSiRange, [props.disposition, deplacerSiRange]);

  const ouvrirFichier = useCallback(
    async (chemin: string, autreColonne: boolean) => {
      const { openFile, disposition } = propsRef.current;
      if (!openFile) return;
      setOuverte(null);
      enAttente.current = autreColonne && disposition ? { chemin, depuis: disposition.focus } : null;
      const ok = await openFile(entreeFichier(chemin));
      if (!ok) enAttente.current = null;
      else deplacerSiRange();
    },
    [deplacerSiRange],
  );

  if (ouverte === "fichiers") {
    return (
      <PaletteFichiers
        dossier={props.workspacePath}
        onOuvrir={(chemin, autre) => void ouvrirFichier(chemin, autre)}
        onFermer={() => setOuverte(null)}
      />
    );
  }
  return null;
}

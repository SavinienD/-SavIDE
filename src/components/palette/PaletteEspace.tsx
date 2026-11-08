// Palettes d'un dossier ouvert : Ctrl+P (fichier par son nom) et Ctrl+K (aller à).
// Montée dans Workspace.tsx (une ligne d'accroche par disposition) ; tout le reste vit ici.
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { fournirActions } from "../../axe/raccourcis";
import { trouver, type EtatColonnes } from "../chat/colonnes";
import type { WorkspaceEntry } from "../../types";
import { entreeFichier, versColonneVoisine } from "./ouvertureFichier";
import { PaletteAller, type ContexteAller } from "./PaletteAller";
import { PaletteFichiers } from "./PaletteFichiers";
import { noterFichierRecent } from "./recents";
import { EVENEMENT_RECHERCHE_DOSSIER } from "./rechercheDossier";
import { actionsAide, actionsEditeurs } from "./actionsAide";
import { editeursDetectes, ouvrableLocalement, type Editeur } from "./ouvrirAvec";

type Props = {
  workspacePath: string;
  layout: "ide" | "chat";
  /** Fichier de l'onglet actif de l'éditeur (noté dans les récents). */
  fichierActif?: string | null;
  openFile?: (entry: WorkspaceEntry) => Promise<boolean>;
  disposition?: EtatColonnes<string>;
  setDisposition?: Dispatch<SetStateAction<EtatColonnes<string>>>;
  // Ctrl+K
  ongletsChat?: { id: string; titre: string }[];
  ongletsFichiers?: { relativePath: string }[];
  conversationActive?: string;
  choisirConversation?: (id: string) => unknown;
  ouvrirDossier?: (chemin: string, conversationId?: string) => unknown;
  ouvrirLibre?: (conversationId?: string) => unknown;
  ouvrirReglages?: () => unknown;
  afficherTerminal?: () => unknown;
  /** Ouvre le volet de recherche (« Rechercher dans ce dossier » de l'explorateur). */
  ouvrirRecherche?: () => unknown;
};

type Ouverte = null | "fichiers" | "aller";

export function PaletteEspace(props: Props) {
  const [ouverte, setOuverte] = useState<Ouverte>(null);
  // Éditeurs du poste (« Ouvrir dans VS Code »…), cherchés une fois.
  const [editeurs, setEditeurs] = useState<Editeur[]>([]);
  useEffect(() => {
    let vivant = true;
    if (ouvrableLocalement(props.workspacePath)) void editeursDetectes().then((e) => vivant && setEditeurs(e));
    return () => {
      vivant = false;
    };
  }, [props.workspacePath]);
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
        allerA: () => setOuverte("aller"),
      }),
    [],
  );

  // « Rechercher dans ce dossier » (clic droit dans l'explorateur) : le volet de recherche s'ouvre.
  useEffect(() => {
    const ouvrir = () => void propsRef.current.ouvrirRecherche?.();
    window.addEventListener(EVENEMENT_RECHERCHE_DOSSIER, ouvrir);
    return () => window.removeEventListener(EVENEMENT_RECHERCHE_DOSSIER, ouvrir);
  }, []);

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

  const contexte = useMemo<ContexteAller>(
    () => ({
      dossier: props.workspacePath,
      disposition: props.layout,
      ongletsChat: props.ongletsChat,
      ongletsFichiers: props.ongletsFichiers,
      conversationActive: props.conversationActive,
      choisirConversation: props.choisirConversation,
      ouvrirFichier: props.openFile ? (chemin: string) => void ouvrirFichier(chemin, false) : undefined,
      ouvrirDossier: props.ouvrirDossier,
      ouvrirLibre: props.ouvrirLibre,
      ouvrirReglages: props.ouvrirReglages,
      afficherTerminal: props.afficherTerminal,
      actions: [
        ...(props.layout === "ide" ? actionsEditeurs(editeurs, props.workspacePath, props.fichierActif ?? null) : []),
        ...actionsAide(),
      ],
    }),
    // Lu à l'ouverture de la palette : pas besoin de suivre chaque rendu de l'espace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ouverte],
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
  if (ouverte === "aller") return <PaletteAller contexte={contexte} onFermer={() => setOuverte(null)} />;
  return null;
}

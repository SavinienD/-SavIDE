// Worktrees — point d'entrée monté par Workspace.tsx : dialogue « Nouveau
// worktree », cartes des tâches de fond, ouverture du worktree créé (une
// conversation à son nom, les terminaux du projet), raccourci clavier.
// Les autres écrans l'ouvrent par l'événement EVENEMENT_OUVRIR_WORKTREES.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/ipc";
import { fournirActions } from "../../axe/raccourcis";
import { installerMagasin, instantaneTaches, lanceeIci, noterLanceeIci, surChangement } from "./magasin";
import { NouveauWorktree } from "./NouveauWorktree";
import { NettoyageWorktrees } from "./NettoyageWorktrees";
import { loadRecents } from "../../lib/recents";
import { TachesWorktrees } from "./TachesWorktrees";
import { preparerTerminaux } from "./terminauxDepart";
import { memeChemin } from "./logique";
import type { TacheWorktree, TerminalDefaut } from "./worktreesApi";
import { EVENEMENT_OUVRIR_WORKTREES, dossierLocal, type DemandeOuverture } from "./evenements";
import "./worktrees.css";

/** Contrat commun des lots 186 : le lot « agents » affiche ces notifications. */
function notifier(t: TacheWorktree): void {
  window.dispatchEvent(
    new CustomEvent("ide-notification", {
      detail: { genre: t.etat === "reussi" ? "fini" : "echec", titre: t.titre, texte: t.message, dossier: t.dossier },
    }),
  );
}

export function WorktreesRacine({
  dossier,
  onOuvrirDossier,
  onFermerTerminaux,
  onAfficherTerminal,
}: {
  /** Dossier ouvert dans la fenêtre. */
  dossier: string;
  onOuvrirDossier: (chemin: string, conversationId?: string) => void;
  onFermerTerminaux: () => void;
  onAfficherTerminal: () => void;
}) {
  const [depart, setDepart] = useState<string | null>(null);
  const [nettoyage, setNettoyage] = useState<string[] | null>(null);
  const dossierRef = useRef(dossier);
  dossierRef.current = dossier;
  /** Terminaux à ouvrir avec chaque worktree créé ici (accord compris). */
  const terminaux = useRef(new Map<string, { terminaux: TerminalDefaut[]; depuis: string }>());
  const attente = useRef<{ dossier: string; terminaux: TerminalDefaut[] } | null>(null);

  useEffect(() => installerMagasin(), []);

  useEffect(() => {
    const ouvrir = (e: Event) => {
      const d = (e as CustomEvent<DemandeOuverture>).detail ?? {};
      if (d.vue === "nettoyage") {
        // Un dépôt donné, sinon ceux du dossier ouvert et des dossiers récents.
        const chemins = d.depot ? [d.depot] : [dossierRef.current, ...loadRecents().map((r) => r.path)];
        setNettoyage(chemins.filter(dossierLocal));
        return;
      }
      const cible = d.depot || dossierRef.current;
      if (dossierLocal(cible)) setDepart(cible);
    };
    window.addEventListener(EVENEMENT_OUVRIR_WORKTREES, ouvrir);
    return () => window.removeEventListener(EVENEMENT_OUVRIR_WORKTREES, ouvrir);
  }, []);

  useEffect(
    () =>
      fournirActions({
        nouveauWorktree: () => {
          if (!dossierLocal(dossierRef.current)) return false;
          setDepart(dossierRef.current);
        },
      }),
    [],
  );

  const ouvrir = useCallback(
    async (t: TacheWorktree) => {
      const prevu = terminaux.current.get(t.id);
      let conversationId: string | undefined;
      try {
        const amorce = await api.createConversation(t.dossier);
        conversationId = amorce.activeConversation.id;
        await api.renameConversation(t.dossier, conversationId, t.titre).catch(() => undefined);
      } catch {
        conversationId = undefined; // la conversation par défaut du dossier
      }
      attente.current = { dossier: t.dossier, terminaux: prevu?.terminaux ?? [] };
      terminaux.current.delete(t.id);
      onFermerTerminaux();
      onOuvrirDossier(t.dossier, conversationId);
    },
    [onFermerTerminaux, onOuvrirDossier],
  );
  const ouvrirRef = useRef(ouvrir);
  ouvrirRef.current = ouvrir;

  // Le dossier a changé : si c'est le worktree attendu, ses terminaux s'ouvrent.
  useEffect(() => {
    const a = attente.current;
    if (!a || !memeChemin(a.dossier, dossier)) return;
    attente.current = null;
    preparerTerminaux(dossier, a.terminaux);
    onAfficherTerminal();
  }, [dossier, onAfficherTerminal]);

  // Worktree prêt : la fenêtre qui l'a demandé y va, si l'on n'a pas changé de dossier entre-temps.
  useEffect(
    () =>
      surChangement((t, avant) => {
        if (lanceeIci(t.id) && t.etat !== avant?.etat && (t.etat === "reussi" || t.etat === "echec")) notifier(t);
        if (t.genre !== "creation" || !t.pret || avant?.pret || !lanceeIci(t.id)) return;
        const prevu = terminaux.current.get(t.id);
        if (prevu && memeChemin(prevu.depuis, dossierRef.current)) void ouvrirRef.current(t);
      }),
    [],
  );

  const lancee = useCallback((t: TacheWorktree, liste: TerminalDefaut[]) => {
    noterLanceeIci(t.id);
    terminaux.current.set(t.id, { terminaux: liste, depuis: dossierRef.current });
    const deja = instantaneTaches().find((x) => x.id === t.id);
    if (deja?.pret) void ouvrirRef.current(deja);
  }, []);

  return (
    <>
      {depart ? <NouveauWorktree depart={depart} onFermer={() => setDepart(null)} onLancee={lancee} /> : null}
      {nettoyage ? <NettoyageWorktrees chemins={nettoyage} dossierOuvert={dossier} onFermer={() => setNettoyage(null)} /> : null}
      <TachesWorktrees dossierCourant={dossier} onOuvrir={(t) => void ouvrir(t)} />
    </>
  );
}

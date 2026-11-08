// Worktrees — écran « Nettoyer les worktrees » : fusionnés, introuvables
// (dossier disparu), anciens (plus de N jours sans activité), taille sur disque ;
// suppression groupée après confirmation, « Oublier les introuvables » (git worktree prune).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialogue } from "./Dialogue";
import { noterLanceeIci } from "./magasin";
import { ConfirmationSuppression, type ChoixSuppression } from "./Confirmations";
import { texteErreur, worktreesApi, type InfoNettoyage, type WorktreeInfo } from "./worktreesApi";
import { avecReglagesDepot, cheminAffiche, ecrireReglages, filtrerNettoyage, ilYa, joursDepuis, lireReglages, memeChemin, nomDe, tailleLisible, type FiltreNettoyage } from "./logique";

const stockage = () => (typeof window !== "undefined" ? window.localStorage : null);
const JOURS = [7, 14, 30, 60, 90];

export function NettoyageWorktrees({ chemins, dossierOuvert, onFermer }: { chemins: string[]; dossierOuvert: string; onFermer: () => void }) {
  const [infos, setInfos] = useState<InfoNettoyage[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [filtre, setFiltre] = useState<FiltreNettoyage>("tous");
  const [jours, setJours] = useState(30);
  const [choisis, setChoisis] = useState<string[]>([]);
  const [confirmer, setConfirmer] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const maintenant = useMemo(() => Date.now(), [infos]);

  const charger = useCallback(async () => {
    setErreur(null);
    try {
      const bases: Record<string, string> = {};
      for (const [k, v] of Object.entries(lireReglages(stockage()).depots)) if (v.base) bases[k] = v.base;
      const liste = await worktreesApi.nettoyage(chemins, bases);
      setInfos(liste);
      // Choix proposé : introuvables, et fusionnés sans fichier modifié.
      setChoisis(liste.filter((i) => !memeChemin(i.dossier, dossierOuvert) && (i.introuvable || (i.fusionne && !i.modifies))).map((i) => i.dossier));
    } catch (e) {
      setErreur(texteErreur(e));
      setInfos([]);
    }
  }, [chemins, dossierOuvert]);
  useEffect(() => {
    void charger();
  }, [charger]);

  const visibles = useMemo(() => filtrerNettoyage(infos ?? [], filtre, jours, maintenant), [infos, filtre, jours, maintenant]);
  const compte = (f: FiltreNettoyage) => filtrerNettoyage(infos ?? [], f, jours, maintenant).length;
  const choix = (infos ?? []).filter((i) => choisis.some((d) => memeChemin(d, i.dossier)));
  const total = choix.reduce((s, i) => s + (i.octets ?? 0), 0);
  const introuvables = (infos ?? []).filter((i) => i.introuvable);
  const basculer = (dossier: string) =>
    setChoisis((l) => (l.some((d) => memeChemin(d, dossier)) ? l.filter((d) => !memeChemin(d, dossier)) : [...l, dossier]));

  const oublierIntrouvables = async () => {
    const depots = [...new Set(introuvables.map((i) => i.depot))];
    let n = 0;
    try {
      for (const d of depots) n += await worktreesApi.oublierIntrouvables(d);
      setMessage(n ? `${n} worktree(s) introuvable(s) oublié(s) par git.` : "Rien à oublier.");
      await charger();
    } catch (e) {
      setMessage(texteErreur(e));
    }
  };

  const aSupprimer: (WorktreeInfo & { depot: string })[] = choix
    .filter((i) => !memeChemin(i.dossier, dossierOuvert))
    .map((i) => ({
      depot: i.depot, dossier: i.dossier, nom: nomDe(i.dossier), branche: i.branche, principal: false, detache: !i.branche, verrouille: false,
      introuvable: i.introuvable, modifies: i.modifies, avance: null, retard: null, reference: null, dernierCommitMs: null,
    }));

  const supprimer = async (c: ChoixSuppression) => {
    const premier = aSupprimer[0]?.depot;
    const erreurs: string[] = [];
    for (const w of aSupprimer) {
      const memeDepot = memeChemin(w.depot, premier ?? "");
      try {
        const t = await worktreesApi.supprimer({
          depot: w.depot, dossier: w.dossier, archiver: false, supprimerBranche: c.supprimerBranches, forcerBranche: false,
          forcer: c.forcer, lancerScript: c.lancerScript && memeDepot, empreinte: memeDepot ? c.empreinte : null, titre: w.nom,
        });
        noterLanceeIci(t.id);
      } catch (e) {
        erreurs.push(`${w.nom} : ${texteErreur(e)}`);
      }
    }
    const empreinte = c.empreinte;
    if (empreinte && premier) ecrireReglages(stockage(), avecReglagesDepot(lireReglages(stockage()), premier, { approuve: empreinte }));
    if (erreurs.length) throw new Error(erreurs.join("\n"));
    onFermer();
  };

  if (confirmer && aSupprimer.length) {
    return <ConfirmationSuppression mode="supprimer" depot={aSupprimer[0].depot} worktrees={aSupprimer} onFermer={() => setConfirmer(false)} onConfirmer={supprimer} />;
  }

  return (
    <Dialogue
      titre="Nettoyer les worktrees"
      description="Rien n'est supprimé sans confirmation. Le dossier ouvert n'est pas proposé."
      libelle={aSupprimer.length ? `Supprimer (${aSupprimer.length})` : "Supprimer"}
      danger
      desactive={!aSupprimer.length}
      onValider={() => setConfirmer(true)}
      onFermer={onFermer}
      annuler="Fermer"
      large
      classe="wt-nettoyage"
    >
      <div className="wt-filtres" role="group" aria-label="Filtres">
        {(
          [
            ["tous", "Tous"],
            ["fusionnes", "Fusionnés"],
            ["introuvables", "Introuvables"],
            ["anciens", "Anciens"],
          ] as [FiltreNettoyage, string][]
        ).map(([f, libelle]) => (
          <button key={f} type="button" className="wt-filtre" data-filtre={f} aria-pressed={filtre === f} onClick={() => setFiltre(f)}>
            {libelle} ({infos ? compte(f) : "…"})
          </button>
        ))}
        <label className="wt-filtres__jours" title="Sans commit ni fichier modifié depuis">
          <span>plus de</span>
          <select className="git-panel__dialog-select" value={jours} onChange={(e) => setJours(Number(e.target.value))} aria-label="Ancienneté en jours">
            {JOURS.map((j) => (
              <option key={j} value={j}>
                {j} jours
              </option>
            ))}
          </select>
        </label>
      </div>
      {erreur ? <div className="git-panel__dialog-error" role="alert">{erreur}</div> : null}
      {message ? <div className="wt-nettoyage__message" role="status">{message}</div> : null}
      <ul className="wt-nettoyage__liste" aria-busy={infos === null}>
        {infos === null ? <li className="wt-nettoyage__vide">Mesure des worktrees…</li> : null}
        {infos !== null && !visibles.length ? <li className="wt-nettoyage__vide">Aucun worktree dans ce filtre.</li> : null}
        {visibles.map((i) => {
          const ouvert = memeChemin(i.dossier, dossierOuvert);
          const age = joursDepuis(i.activiteMs, maintenant);
          return (
            <li key={i.dossier} className="wt-nettoyage__ligne" data-introuvable={i.introuvable ? "true" : "false"} data-ouvert={ouvert ? "true" : "false"}>
              <label className="wt-ligne__case" title={ouvert ? "Dossier ouvert dans cette fenêtre" : "Choisir"}>
                <input type="checkbox" disabled={ouvert} checked={choisis.some((d) => memeChemin(d, i.dossier))} onChange={() => basculer(i.dossier)} aria-label={`Choisir ${nomDe(i.dossier)}`} />
              </label>
              <span className="wt-nettoyage__nom" title={cheminAffiche(i.dossier)}>
                <span>{nomDe(i.dossier)}</span>
                <span className="wt-ligne__branche">{i.branche ?? "HEAD détachée"} · {nomDe(i.depot)}</span>
              </span>
              <span className="wt-nettoyage__etat">
                {i.introuvable ? <span className="wt-badge" data-genre="alerte">introuvable</span> : null}
                {i.fusionne ? <span className="wt-badge">fusionné</span> : null}
                {i.modifies ? <span className="wt-badge" data-genre="alerte">{i.modifies} modif.</span> : null}
              </span>
              <span className="wt-nettoyage__activite" title={Number.isFinite(age) ? `${age} jour(s)` : undefined}>{i.introuvable ? "—" : ilYa(i.activiteMs, maintenant)}</span>
              <span className="wt-nettoyage__taille">{i.octets == null ? "—" : `${i.tailleCoupee ? "≥ " : ""}${tailleLisible(i.octets)}`}</span>
            </li>
          );
        })}
      </ul>
      <div className="wt-nettoyage__pied">
        <span className="wt-nettoyage__total">
          {choix.length} choisi{choix.length > 1 ? "s" : ""}{total ? ` · ${tailleLisible(total)}` : ""}
        </span>
        {introuvables.length ? (
          <button type="button" className="git-panel__dialog-btn" data-action="oublier-introuvables" onClick={() => void oublierIntrouvables()}>
            Oublier les introuvables ({introuvables.length})
          </button>
        ) : null}
      </div>
    </Dialogue>
  );
}

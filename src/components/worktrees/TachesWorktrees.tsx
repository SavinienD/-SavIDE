// Worktrees — cartes des tâches de fond (en haut à droite de la fenêtre) :
// étapes, message, terminal du script, et les gestes utiles selon l'état
// (Annuler, Réessayer, Relancer, Supprimer quand même, Ouvrir, Fermer).
import { useEffect, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react";
import { abonner, instantaneTaches, retirer } from "./magasin";
import { TerminalScript } from "./TerminalScript";
import { texteErreur, worktreesApi, type TacheWorktree } from "./worktreesApi";
import { avecReglagesDepot, cheminAffiche, ecrireReglages, etapesAffichees, lireReglages, memeChemin } from "./logique";

const stockage = () => (typeof window !== "undefined" ? window.localStorage : null);

export function TachesWorktrees({
  dossierCourant,
  onOuvrir,
}: {
  dossierCourant: string;
  onOuvrir: (tache: TacheWorktree) => void;
}) {
  const taches = useSyncExternalStore(abonner, instantaneTaches);
  if (!taches.length) return null;
  return (
    <div className="wt-taches" role="region" aria-label="Tâches des worktrees">
      {taches.map((t) => (
        <CarteTache key={t.id} tache={t} ouvert={memeChemin(t.dossier, dossierCourant)} onOuvrir={onOuvrir} />
      ))}
    </div>
  );
}

function CarteTache({ tache: t, ouvert, onOuvrir }: { tache: TacheWorktree; ouvert: boolean; onOuvrir: (t: TacheWorktree) => void }) {
  const [erreur, setErreur] = useState<string | null>(null);
  const [voirTerminal, setVoirTerminal] = useState<boolean | null>(null);
  const [voirDetail, setVoirDetail] = useState(false);
  const fin = t.etat !== "en_cours";
  const terminalVisible = Boolean(t.script) && (voirTerminal ?? Boolean(t.script?.enCours));

  // Une tâche réussie sans avertissement se retire seule.
  useEffect(() => {
    if (t.etat !== "reussi" || t.avertissements.length) return;
    const minuterie = window.setTimeout(() => void fermer(), 6000);
    return () => window.clearTimeout(minuterie);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.etat, t.avertissements.length]);

  const agir = async (f: () => Promise<unknown>) => {
    setErreur(null);
    try {
      await f();
    } catch (e) {
      setErreur(texteErreur(e));
    }
  };
  const fermer = () =>
    agir(async () => {
      await worktreesApi.oublier(t.id).catch(() => undefined);
      retirer(t.id);
    });
  const reprendre = (r: { sansScript?: boolean; forcer?: boolean; empreinte?: string | null }) => agir(() => worktreesApi.reprendre(t.id, r));
  const accepterEtRelancer = () =>
    agir(async () => {
      const c = await worktreesApi.config(t.depot);
      const empreinte = c.config.empreinte;
      if (!empreinte) return worktreesApi.reprendre(t.id, { sansScript: true });
      ecrireReglages(stockage(), avecReglagesDepot(lireReglages(stockage()), c.depot, { approuve: empreinte }));
      return worktreesApi.reprendre(t.id, { empreinte });
    });

  const creation = t.genre === "creation";
  const boutons: { cle: string; libelle: string; action: () => void; principal?: boolean; danger?: boolean }[] = [];
  if (t.etat === "en_cours") {
    if (t.etape === "script") boutons.push({ cle: "arreter", libelle: creation ? "Arrêter le script" : "Annuler", action: () => void agir(() => worktreesApi.annuler(t.id)) });
    else if (creation) boutons.push({ cle: "annuler", libelle: "Annuler", action: () => void agir(() => worktreesApi.annuler(t.id)) });
  } else if (t.etat === "echec" || t.etat === "annule") {
    if (t.raison === "modifie") boutons.push({ cle: "forcer", libelle: "Supprimer quand même", danger: true, principal: true, action: () => void reprendre({ forcer: true }) });
    else if (t.raison === "empreinte") boutons.push({ cle: "accepter", libelle: "Accepter et relancer", principal: true, action: () => void accepterEtRelancer() });
    else if (t.etape === "script") boutons.push({ cle: "relancer", libelle: "Relancer", principal: true, action: () => void reprendre({}) });
    else if (t.raison !== "dossier") boutons.push({ cle: "reessayer", libelle: "Réessayer", principal: true, action: () => void reprendre({}) });
    if (!creation && t.etape === "script") boutons.push({ cle: "sans-script", libelle: "Continuer sans le script", action: () => void reprendre({ sansScript: true }) });
  }
  if (creation && t.pret && !ouvert) boutons.push({ cle: "ouvrir", libelle: "Ouvrir", principal: t.etat === "reussi", action: () => onOuvrir(t) });
  if (fin) boutons.push({ cle: "fermer", libelle: "Fermer", action: () => void fermer() });

  const icone =
    t.etat === "reussi" ? "solar:check-circle-linear" : t.etat === "echec" ? "solar:danger-triangle-linear" : t.etat === "annule" ? "solar:close-circle-linear" : "solar:refresh-linear";
  return (
    <section className="wt-carte" data-etat={t.etat} data-genre={t.genre} aria-live="polite" title={cheminAffiche(t.dossier)}>
      <div className="wt-carte__tete">
        <Icon icon={icone} width={14} height={14} className="wt-carte__icone" data-tourne={t.etat === "en_cours" ? "true" : "false"} />
        <span className="wt-carte__titre">{t.titre}</span>
        {t.branche ? <span className="wt-carte__branche">{t.branche}</span> : null}
      </div>
      <ol className="wt-carte__etapes">
        {etapesAffichees(t).map((e) => (
          <li key={e.cle} data-etat={e.etat}>{e.libelle}</li>
        ))}
      </ol>
      <div className="wt-carte__message">{t.message}</div>
      {t.detail ? (
        <div className="wt-carte__detail">
          <button type="button" className="wt-lien-texte" aria-expanded={voirDetail} onClick={() => setVoirDetail((v) => !v)}>
            {voirDetail ? "Masquer le détail" : "Voir le détail"}
          </button>
          {voirDetail ? <pre>{t.detail}</pre> : null}
        </div>
      ) : null}
      {t.avertissements.length ? (
        <ul className="wt-carte__avertissements">
          {t.avertissements.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
      {t.script ? (
        <div className="wt-carte__script">
          <button type="button" className="wt-lien-texte" aria-expanded={terminalVisible} onClick={() => setVoirTerminal(!terminalVisible)}>
            <Icon icon={terminalVisible ? "solar:alt-arrow-down-linear" : "solar:alt-arrow-right-linear"} width={12} height={12} />
            <span>
              Terminal du script
              {t.script.code != null ? ` (code ${t.script.code})` : t.script.enCours ? " (en cours)" : ""}
            </span>
          </button>
          {terminalVisible ? <TerminalScript tache={t} /> : null}
        </div>
      ) : null}
      {erreur ? <div className="git-panel__dialog-error">{erreur}</div> : null}
      {boutons.length ? (
        <div className="wt-carte__actions">
          {boutons.map((b) => (
            <button
              key={b.cle}
              type="button"
              data-action={b.cle}
              className={`git-panel__dialog-btn${b.principal ? " git-panel__dialog-btn--primary" : ""}`}
              data-danger={b.danger ? "true" : "false"}
              onClick={b.action}
            >
              {b.libelle}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

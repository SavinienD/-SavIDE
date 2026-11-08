// Worktrees — liste « Worktrees » (onglet du volet bas de la barre latérale) :
// un groupe par dépôt (dossier ouvert et dossiers récents), état de chaque worktree
// (fichiers modifiés, en avance / en retard), épingles, sélection multiple (case,
// Ctrl+clic, Maj+clic), suppression et archivage en lot, lien PR / issue, « Endormir ».
// Clavier : Tab parcourt les lignes, Entrée ouvre, Espace coche, Suppr supprime.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import { loadRecents } from "../../lib/recents";
import { infoBulle } from "../../axe/raccourcis";
import { dossierLocal, ouvrirWorktrees } from "./evenements";
import { abonner, instantaneTaches, noterLanceeIci, surChangement } from "./magasin";
import "./worktrees.css";
import { MenuFlottant, type EntreeMenu } from "./Menu";
import { ConfirmationSuppression, DialogueBase, DialogueLien, type ChoixSuppression } from "./Confirmations";
import { texteErreur, worktreesApi, type DepotWorktrees, type TacheWorktree, type WorktreeInfo } from "./worktreesApi";
import {
  avecLien,
  avecReglagesDepot,
  basculer,
  cheminAffiche,
  commandesApprouvees,
  contient,
  ecrireReglages,
  ilYa,
  libelleLien,
  lienDe,
  lireReglages,
  memeChemin,
  ordonnerWorktrees,
  reglagesDepot,
  type Archive,
  type Reglages,
} from "./logique";

const stockage = () => (typeof window !== "undefined" ? window.localStorage : null);
const RAFRAICHIR_MS = 30_000;

type Choisi = WorktreeInfo & { depot: string };

/** Onglet « Worktrees » du volet bas (dossiers de ce poste seulement). */
export function OngletWorktrees({ dossier, actif, onActiver }: { dossier: string; actif: boolean; onActiver: () => void }) {
  if (!dossierLocal(dossier)) return null;
  return (
    <button
      type="button"
      role="tab"
      className="sidebar-tab"
      data-active={actif ? "true" : "false"}
      data-onglet="worktrees"
      aria-selected={actif}
      onClick={onActiver}
      title="Worktrees"
      aria-label="Worktrees"
    >
      {/* Icône seule : trois onglets avec libellé ne tiennent pas dans la barre latérale. */}
      <Icon icon="solar:branching-paths-up-linear" width={13} height={13} />
    </button>
  );
}

type PropsListe = {
  dossier: string;
  actif: boolean;
  onOuvrirDossier: (chemin: string) => void;
  onFermerTerminaux: () => void;
};

/** Panneau de l'onglet (toujours monté, comme les autres : la sélection reste). */
export function PanneauWorktrees(props: PropsListe) {
  if (!dossierLocal(props.dossier)) return null;
  return (
    <div className="sidebar-tab-pane wt-panneau" role="tabpanel" aria-hidden={!props.actif} style={{ display: props.actif ? "flex" : "none" }}>
      <ListeWorktrees {...props} />
    </div>
  );
}

function ListeWorktrees({ dossier, actif, onOuvrirDossier, onFermerTerminaux }: PropsListe) {
  const [depots, setDepots] = useState<DepotWorktrees[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [lecture, setLecture] = useState(false);
  const [reglages, setReglagesEtat] = useState<Reglages>(() => lireReglages(stockage()));
  const reglagesRef = useRef(reglages);
  reglagesRef.current = reglages;
  const [choisis, setChoisis] = useState<Choisi[]>([]);
  const [menu, setMenu] = useState<{ x: number; y: number; entrees: EntreeMenu[] } | null>(null);
  const [confirmation, setConfirmation] = useState<{ mode: "supprimer" | "archiver"; worktrees: Choisi[] } | null>(null);
  const [lienEdite, setLienEdite] = useState<WorktreeInfo | null>(null);
  const [baseEditee, setBaseEditee] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const taches = useSyncExternalStore(abonner, instantaneTaches);
  const actifRef = useRef(actif);
  actifRef.current = actif;
  const archivesEnAttente = useRef(new Map<string, Archive>());
  const restaurations = useRef(new Map<string, Archive>());

  const majReglages = useCallback((f: (r: Reglages) => Reglages) => {
    const suivant = f(reglagesRef.current);
    reglagesRef.current = suivant;
    ecrireReglages(stockage(), suivant);
    setReglagesEtat(suivant);
  }, []);

  const charger = useCallback(async () => {
    const chemins = [dossier, ...loadRecents().map((r) => r.path)];
    const bases: Record<string, string> = {};
    for (const [k, v] of Object.entries(reglagesRef.current.depots)) if (v.base) bases[k] = v.base;
    setLecture(true);
    try {
      setDepots(await worktreesApi.lister(chemins, bases));
      setErreur(null);
    } catch (e) {
      setErreur(texteErreur(e));
    } finally {
      setLecture(false);
    }
  }, [dossier]);

  useEffect(() => {
    if (!actif) return;
    void charger();
    const id = window.setInterval(() => void charger(), RAFRAICHIR_MS);
    return () => window.clearInterval(id);
  }, [actif, charger]);

  // Fin d'une tâche : archive notée, archive restaurée retirée, liste relue.
  useEffect(
    () =>
      surChangement((t, avant) => {
        if (t.etat === "reussi" && avant?.etat !== "reussi") {
          const a = archivesEnAttente.current.get(t.id);
          if (a) {
            archivesEnAttente.current.delete(t.id);
            majReglages((r) => ({ ...r, archives: [...r.archives.filter((x) => !(memeChemin(x.depot, a.depot) && x.branche === a.branche)), a] }));
          }
        }
        if (t.pret && !avant?.pret) {
          const a = restaurations.current.get(t.id);
          if (a) {
            restaurations.current.delete(t.id);
            majReglages((r) => {
              const sans = { ...r, archives: r.archives.filter((x) => !(memeChemin(x.depot, a.depot) && x.branche === a.branche)) };
              return a.lien ? avecLien(sans, t.dossier, a.lien) : sans;
            });
          }
        }
        if (t.etat !== "en_cours" && avant?.etat === "en_cours" && actifRef.current) void charger();
      }),
    [charger, majReglages],
  );

  const ouvrir = (w: WorktreeInfo) => {
    if (memeChemin(w.dossier, dossier) || w.introuvable) return;
    majReglages((r) => ({ ...r, endormis: r.endormis.filter((d) => !memeChemin(d, w.dossier)) }));
    onOuvrirDossier(w.dossier);
  };

  const endormir = async (ws: WorktreeInfo[]) => {
    for (const w of ws) {
      const conversations = await api.listConversations(w.dossier).catch(() => []);
      await Promise.all(conversations.map((c) => api.cancelTurn(w.dossier, c.id).catch(() => false)));
      for (const t of instantaneTaches()) {
        if (t.etat === "en_cours" && t.etape === "script" && memeChemin(t.dossier, w.dossier)) await worktreesApi.annuler(t.id).catch(() => undefined);
      }
      if (memeChemin(w.dossier, dossier)) onFermerTerminaux();
    }
    majReglages((r) => ({ ...r, endormis: [...r.endormis, ...ws.map((w) => w.dossier).filter((d) => !contient(r.endormis, d))] }));
    setChoisis([]);
    setMessage(ws.length === 1 ? `${ws[0].nom} endormi : terminaux fermés, conversations arrêtées.` : `${ws.length} worktrees endormis.`);
  };

  const reveiller = (w: WorktreeInfo) => majReglages((r) => ({ ...r, endormis: r.endormis.filter((d) => !memeChemin(d, w.dossier)) }));

  const demander = (mode: "supprimer" | "archiver", ws: Choisi[]) => {
    const retenus = ws.filter((w) => !w.principal && !memeChemin(w.dossier, dossier) && (mode === "supprimer" || w.branche));
    if (retenus.length < ws.length) setMessage("Le dossier ouvert et le dossier principal du dépôt ne se retirent pas d'ici.");
    if (retenus.length) setConfirmation({ mode, worktrees: retenus });
  };

  const confirmer = async (choix: ChoixSuppression) => {
    const c = confirmation;
    if (!c) return;
    const erreurs: string[] = [];
    for (const w of c.worktrees) {
      try {
        const t = await worktreesApi.supprimer({
          depot: w.depot,
          dossier: w.dossier,
          archiver: c.mode === "archiver",
          supprimerBranche: choix.supprimerBranches,
          forcerBranche: false,
          forcer: choix.forcer,
          lancerScript: choix.lancerScript,
          empreinte: choix.empreinte,
          titre: w.nom,
        });
        noterLanceeIci(t.id);
        if (c.mode === "archiver" && w.branche) {
          archivesEnAttente.current.set(t.id, { depot: w.depot, branche: w.branche, titre: w.nom, dossier: w.dossier, dateMs: Date.now(), lien: lienDe(reglagesRef.current, w.dossier) });
        }
      } catch (e) {
        erreurs.push(`${w.nom} : ${texteErreur(e)}`);
      }
    }
    const empreinte = choix.empreinte;
    if (empreinte) majReglages((r) => avecReglagesDepot(r, c.worktrees[0].depot, { approuve: empreinte }));
    setChoisis([]);
    if (erreurs.length) throw new Error(erreurs.join("\n"));
  };

  const restaurer = async (a: Archive) => {
    try {
      const cfg = await worktreesApi.config(a.depot);
      const accord = Boolean(cfg.config.empreinte) && commandesApprouvees(reglagesRef.current, cfg.depot, cfg.config.empreinte);
      const t = await worktreesApi.creer({ depot: a.depot, titre: a.titre, branche: a.branche, base: null, lancerScript: accord, empreinte: accord ? cfg.config.empreinte : null });
      noterLanceeIci(t.id);
      restaurations.current.set(t.id, a);
    } catch (e) {
      setMessage(texteErreur(e));
    }
  };

  const choisir = (d: DepotWorktrees, w: WorktreeInfo, plage: boolean) => {
    if (w.principal) return;
    setChoisis((liste) => {
      const memeDepot = liste.filter((x) => memeChemin(x.depot, d.depot));
      if (plage && memeDepot.length) {
        const ordre = ordonnerWorktrees(d.worktrees, reglagesRef.current.epingles).filter((x) => !x.principal);
        const i = ordre.findIndex((x) => memeChemin(x.dossier, memeDepot[memeDepot.length - 1].dossier));
        const j = ordre.findIndex((x) => memeChemin(x.dossier, w.dossier));
        const [a, b] = i < j ? [i, j] : [j, i];
        const ajout = ordre.slice(a, b + 1).filter((x) => !memeDepot.some((y) => memeChemin(y.dossier, x.dossier)));
        return [...memeDepot, ...ajout.map((x) => ({ ...x, depot: d.depot }))];
      }
      if (memeDepot.some((x) => memeChemin(x.dossier, w.dossier))) return memeDepot.filter((x) => !memeChemin(x.dossier, w.dossier));
      return [...memeDepot, { ...w, depot: d.depot }];
    });
  };

  const ouvrirMenu = (e: MouseEvent<HTMLElement>, entrees: EntreeMenu[]) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: e.type === "contextmenu" ? e.clientX : r.right - 220, y: e.type === "contextmenu" ? e.clientY : r.bottom + 4, entrees });
  };

  const entreesLigne = (d: DepotWorktrees, w: WorktreeInfo): EntreeMenu[] => {
    const ouvert = memeChemin(w.dossier, dossier);
    const epingle = contient(reglages.epingles, w.dossier);
    const endormi = contient(reglages.endormis, w.dossier);
    const cible: Choisi[] = choisis.some((x) => memeChemin(x.dossier, w.dossier)) ? choisis : [{ ...w, depot: d.depot }];
    return [
      { cle: "ouvrir", libelle: "Ouvrir", action: () => ouvrir(w), desactive: ouvert || w.introuvable },
      { cle: "epingler", libelle: epingle ? "Désépingler" : "Épingler", action: () => majReglages((r) => ({ ...r, epingles: basculer(r.epingles, w.dossier) })) },
      { cle: "lien", libelle: lienDe(reglages, w.dossier) ? "Modifier le lien PR / issue…" : "Lien PR ou issue…", action: () => setLienEdite(w) },
      { cle: "endormir", libelle: endormi ? "Réveiller" : "Endormir", action: () => (endormi ? reveiller(w) : void endormir(cible)), desactive: w.introuvable },
      { cle: "archiver", libelle: "Archiver…", action: () => demander("archiver", cible), desactive: w.principal || ouvert || !w.branche || w.introuvable },
      { cle: "supprimer", libelle: "Supprimer…", action: () => demander("supprimer", cible), desactive: w.principal || ouvert, danger: true },
    ];
  };

  const entreesDepot = (d: DepotWorktrees): EntreeMenu[] => [
    { cle: "nouveau", libelle: "Nouveau worktree…", action: () => ouvrirWorktrees("nouveau", d.depot) },
    { cle: "base", libelle: "Branche de départ…", action: () => setBaseEditee(d.depot) },
    { cle: "nettoyer", libelle: "Nettoyer…", action: () => ouvrirWorktrees("nettoyage", d.depot) },
  ];

  const toucheLigne = (e: KeyboardEvent<HTMLElement>, d: DepotWorktrees, w: WorktreeInfo) => {
    if (e.key === "Delete") {
      e.preventDefault();
      demander("supprimer", choisis.some((x) => memeChemin(x.dossier, w.dossier)) ? choisis : [{ ...w, depot: d.depot }]);
    } else if (e.key === " " && !w.principal) {
      e.preventDefault();
      choisir(d, w, e.shiftKey);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      setMenu({ x: r.left + 24, y: r.bottom, entrees: entreesLigne(d, w) });
    }
  };

  const ligne = (d: DepotWorktrees, w: WorktreeInfo) => {
    const ouvert = memeChemin(w.dossier, dossier);
    const choisi = choisis.some((x) => memeChemin(x.dossier, w.dossier));
    const epingle = contient(reglages.epingles, w.dossier);
    const endormi = contient(reglages.endormis, w.dossier);
    const lien = lienDe(reglages, w.dossier);
    const tache: TacheWorktree | undefined = [...taches].reverse().find((t) => t.etat === "en_cours" && memeChemin(t.dossier, w.dossier));
    const nom = w.principal ? d.nom : w.nom;
    const etat = [
      ouvert ? "ouvert dans cette fenêtre" : null,
      w.modifies ? `${w.modifies} fichier(s) modifié(s)` : null,
      w.dernierCommitMs ? `dernier commit ${ilYa(w.dernierCommitMs, Date.now())}` : null,
    ].filter(Boolean).join(" · ");
    return (
      <li
        key={w.dossier}
        className="wt-ligne"
        data-ouvert={ouvert ? "true" : "false"}
        data-choisi={choisi ? "true" : "false"}
        data-principal={w.principal ? "true" : "false"}
        data-endormi={endormi ? "true" : "false"}
        data-introuvable={w.introuvable ? "true" : "false"}
        onContextMenu={(e) => ouvrirMenu(e, entreesLigne(d, w))}
      >
        <label className="wt-ligne__case" title={w.principal ? "Dossier principal du dépôt" : "Choisir"}>
          <input type="checkbox" checked={choisi} disabled={w.principal} onChange={() => choisir(d, w, false)} aria-label={`Choisir ${nom}`} />
        </label>
        <button
          type="button"
          className="wt-ligne__corps"
          data-action="ouvrir"
          title={`${cheminAffiche(w.dossier)}${etat ? `\n${etat}` : ""}`}
          aria-current={ouvert ? "true" : undefined}
          onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? choisir(d, w, e.shiftKey) : ouvrir(w))}
          onKeyDown={(e) => toucheLigne(e, d, w)}
        >
          <span className="wt-ligne__nom">{nom}</span>
          <span className="wt-ligne__branche">{w.branche ?? (w.detache ? "HEAD détachée" : "—")}</span>
        </button>
        <span className="wt-ligne__etat">
          {tache ? <Icon icon="solar:refresh-linear" width={12} height={12} className="wt-ligne__tache" aria-label={tache.message} /> : null}
          {epingle ? <Icon icon="solar:pin-linear" width={12} height={12} aria-label="Épinglé" /> : null}
          {endormi ? <Icon icon="solar:moon-sleep-linear" width={12} height={12} aria-label="Endormi" /> : null}
          {w.introuvable ? <span className="wt-badge" data-genre="alerte" title="Dossier introuvable : « Nettoyer » l'oublie">absent</span> : null}
          {w.modifies ? <span className="wt-badge" title={`${w.modifies} fichier(s) modifié(s) ou non suivi(s)`}>{w.modifies} modif.</span> : null}
          {w.avance ? <span className="wt-badge" title={`${w.avance} commit(s) en avance sur ${w.reference}`}>↑{w.avance}</span> : null}
          {w.retard ? <span className="wt-badge" title={`${w.retard} commit(s) en retard sur ${w.reference}`}>↓{w.retard}</span> : null}
          {lien ? (
            <button type="button" className="wt-badge wt-badge--lien" title={lien} onClick={() => void api.openExternalUrl(lien)}>
              {libelleLien(lien)}
            </button>
          ) : null}
        </span>
        <button type="button" className="wt-ligne__menu" aria-haspopup="menu" aria-label={`Actions de ${nom}`} data-action="menu" onClick={(e) => ouvrirMenu(e, entreesLigne(d, w))}>
          <Icon icon="solar:menu-dots-bold" width={14} height={14} />
        </button>
      </li>
    );
  };

  const groupe = (d: DepotWorktrees) => {
    const archives = reglages.archives.filter((a) => memeChemin(a.depot, d.depot));
    const base = reglagesDepot(reglages, d.depot).base;
    return (
      <section key={d.depot} className="wt-groupe" aria-label={`Dépôt ${d.nom}`}>
        <div className="wt-groupe__tete">
          <Icon icon="solar:folder-with-files-linear" width={13} height={13} className="wt-groupe__icone" />
          <span className="wt-groupe__nom" title={cheminAffiche(d.depot)}>{d.nom}</span>
          {base ? <span className="wt-groupe__base" title="Branche de départ des nouveaux worktrees">{base}</span> : null}
          <button type="button" className="wt-ligne__menu" aria-haspopup="menu" aria-label={`Actions du dépôt ${d.nom}`} data-action="menu-depot" onClick={(e) => ouvrirMenu(e, entreesDepot(d))}>
            <Icon icon="solar:menu-dots-bold" width={14} height={14} />
          </button>
        </div>
        {d.erreur ? <div className="wt-groupe__erreur">{d.erreur}</div> : null}
        <ul className="wt-groupe__liste">{ordonnerWorktrees(d.worktrees, reglages.epingles).map((w) => ligne(d, w))}</ul>
        {archives.length ? (
          <details className="wt-archives">
            <summary>Archivés ({archives.length})</summary>
            <ul>
              {archives.map((a) => (
                <li key={a.branche} className="wt-archive">
                  <span className="wt-archive__nom" title={`${a.branche} · archivé ${ilYa(a.dateMs, Date.now())}`}>{a.titre}</span>
                  <button type="button" className="git-panel__dialog-btn" data-action="restaurer" onClick={() => void restaurer(a)}>
                    Restaurer
                  </button>
                  <button
                    type="button"
                    className="wt-ligne__menu"
                    aria-label={`Oublier l'archive ${a.titre} (la branche reste)`}
                    title="Oublier (la branche reste)"
                    onClick={() => majReglages((r) => ({ ...r, archives: r.archives.filter((x) => x !== a) }))}
                  >
                    <Icon icon="solar:close-circle-linear" width={14} height={14} />
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>
    );
  };

  return (
    <div className="wt-liste" data-lecture={lecture ? "true" : "false"}>
      <div className="wt-liste__tete">
        <span className="wt-liste__titre">Par dépôt</span>
        <button type="button" className="sidebar__head-btn" data-action="rafraichir" title="Relire l'état" aria-label="Relire l'état" onClick={() => void charger()}>
          <Icon icon="solar:refresh-linear" width={14} height={14} />
        </button>
        <button type="button" className="sidebar__head-btn" data-action="nettoyer" title="Nettoyer les worktrees" aria-label="Nettoyer les worktrees" onClick={() => ouvrirWorktrees("nettoyage")}>
          <Icon icon="solar:broom-linear" width={14} height={14} />
        </button>
        <button type="button" className="sidebar__head-btn" data-action="nouveau-worktree" title={infoBulle("Nouveau worktree", "nouveauWorktree")} aria-label="Nouveau worktree" onClick={() => ouvrirWorktrees("nouveau", dossier)}>
          <Icon icon="solar:add-square-linear" width={15} height={15} />
        </button>
      </div>
      {choisis.length ? (
        <div className="wt-selection" role="toolbar" aria-label="Worktrees choisis">
          <span className="wt-selection__nombre">{choisis.length} choisi{choisis.length > 1 ? "s" : ""}</span>
          <button type="button" className="git-panel__dialog-btn" data-action="endormir-choix" onClick={() => void endormir(choisis)}>
            Endormir
          </button>
          <button type="button" className="git-panel__dialog-btn" data-action="archiver-choix" onClick={() => demander("archiver", choisis)}>
            Archiver
          </button>
          <button type="button" className="git-panel__dialog-btn" data-danger="true" data-action="supprimer-choix" onClick={() => demander("supprimer", choisis)}>
            Supprimer
          </button>
          <button type="button" className="wt-ligne__menu" aria-label="Annuler la sélection" title="Annuler la sélection" onClick={() => setChoisis([])}>
            <Icon icon="solar:close-circle-linear" width={14} height={14} />
          </button>
        </div>
      ) : null}
      {message ? (
        <div className="wt-liste__message" role="status">
          <span>{message}</span>
          <button type="button" className="wt-ligne__menu" aria-label="Fermer le message" onClick={() => setMessage(null)}>
            <Icon icon="solar:close-circle-linear" width={14} height={14} />
          </button>
        </div>
      ) : null}
      {erreur ? <div className="git-panel__dialog-error wt-liste__erreur">{erreur}</div> : null}
      <div className="wt-liste__corps">
        {depots === null ? (
          <div className="wt-liste__vide">Lecture des dépôts…</div>
        ) : depots.length === 0 ? (
          <div className="wt-liste__vide">Aucun dépôt git dans le dossier ouvert ni dans les dossiers récents.</div>
        ) : (
          depots.map(groupe)
        )}
      </div>
      {menu ? <MenuFlottant x={menu.x} y={menu.y} entrees={menu.entrees} onFermer={() => setMenu(null)} /> : null}
      {confirmation ? (
        <ConfirmationSuppression
          mode={confirmation.mode}
          depot={confirmation.worktrees[0].depot}
          worktrees={confirmation.worktrees}
          onFermer={() => setConfirmation(null)}
          onConfirmer={confirmer}
        />
      ) : null}
      {lienEdite ? (
        <DialogueLien
          worktree={lienEdite}
          lien={lienDe(reglages, lienEdite.dossier)}
          onFermer={() => setLienEdite(null)}
          onEnregistrer={(url) => majReglages((r) => avecLien(r, lienEdite.dossier, url))}
        />
      ) : null}
      {baseEditee ? (
        <DialogueBase
          depot={baseEditee}
          base={reglagesDepot(reglages, baseEditee).base}
          onFermer={() => setBaseEditee(null)}
          onEnregistrer={(b) => {
            majReglages((r) => avecReglagesDepot(r, baseEditee, { base: b }));
            void charger();
          }}
        />
      ) : null}
    </div>
  );
}

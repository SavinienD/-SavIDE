// Worktrees — « Nouveau worktree » : titre de la tâche → branche proposée,
// branche de départ (réglage du dépôt), commandes du projet (worktrees.toml) à
// accepter. La création continue en arrière-plan (carte de la tâche).
import { useCallback, useEffect, useState } from "react";
import { Dialogue } from "./Dialogue";
import { texteErreur, worktreesApi, type ConfigDepot, type TacheWorktree, type TerminalDefaut } from "./worktreesApi";
import { avecReglagesDepot, baseParDefaut, commandesApprouvees, ecrireReglages, lireReglages, slug } from "./logique";

const stockage = () => (typeof window !== "undefined" ? window.localStorage : null);

export function NouveauWorktree({
  depart,
  onFermer,
  onLancee,
}: {
  /** Un dossier du dépôt (le dossier ouvert, ou le dépôt choisi dans la liste). */
  depart: string;
  onFermer: () => void;
  onLancee: (tache: TacheWorktree, terminaux: TerminalDefaut[]) => void;
}) {
  const [config, setConfig] = useState<ConfigDepot | null>(null);
  const [erreurChargement, setErreurChargement] = useState<string | null>(null);
  const [titre, setTitre] = useState("");
  const [branche, setBranche] = useState("");
  const [brancheTouchee, setBrancheTouchee] = useState(false);
  const [base, setBase] = useState("");
  const [retenir, setRetenir] = useState(false);
  const [lancer, setLancer] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const appliquer = useCallback((c: ConfigDepot) => {
    const r = lireReglages(stockage());
    setConfig(c);
    setBase((b) => b || baseParDefaut(r, c.depot, c.config.base, c.branchePrincipale, c.branches));
    setLancer(Boolean(c.config.empreinte) && commandesApprouvees(r, c.depot, c.config.empreinte));
  }, []);

  useEffect(() => {
    let vivant = true;
    worktreesApi
      .config(depart)
      .then((c) => vivant && appliquer(c))
      .catch((e) => vivant && setErreurChargement(texteErreur(e)));
    return () => {
      vivant = false;
    };
  }, [appliquer, depart]);

  const brancheEffective = brancheTouchee ? branche.trim() : titre.trim() ? slug(titre) : "";
  const cfg = config?.config;
  const commandes = Boolean(cfg?.empreinte);
  const approuve = config ? commandesApprouvees(lireReglages(stockage()), config.depot, cfg?.empreinte ?? null) : false;

  const creerFichier = useCallback(async () => {
    if (!config) return;
    setErreur(null);
    try {
      appliquer(await worktreesApi.creerConfig(config.depot));
    } catch (e) {
      setErreur(texteErreur(e));
    }
  }, [appliquer, config]);

  const valider = useCallback(async () => {
    if (!config || !brancheEffective || occupe) return;
    setOccupe(true);
    setErreur(null);
    try {
      const empreinte = lancer ? config.config.empreinte : null;
      const tache = await worktreesApi.creer({
        depot: config.depot,
        titre: titre.trim(),
        branche: brancheEffective,
        base: base || null,
        lancerScript: lancer,
        empreinte,
      });
      let r = lireReglages(stockage());
      if (empreinte) r = avecReglagesDepot(r, config.depot, { approuve: empreinte });
      if (retenir && base) r = avecReglagesDepot(r, config.depot, { base });
      ecrireReglages(stockage(), r);
      const terminaux = config.config.terminaux.map((t) => ({ nom: t.nom, commande: lancer ? t.commande : null }));
      onLancee(tache, terminaux);
      onFermer();
    } catch (e) {
      setErreur(texteErreur(e));
      setOccupe(false);
    }
  }, [base, brancheEffective, config, lancer, occupe, onFermer, onLancee, retenir, titre]);

  const branches = config ? [...config.branches] : [];
  if (base && !branches.includes(base)) branches.unshift(base);
  const partages = cfg ? [...cfg.liens.map((l) => `${l} (lien)`), ...cfg.copies.map((c) => `${c} (copie)`)] : [];

  return (
    <Dialogue
      titre="Nouveau worktree"
      description={config ? <>Une branche et son dossier pour la tâche, à côté du dépôt <strong className="git-panel__dialog-strong">{config.nom}</strong>.</> : "Lecture du dépôt…"}
      libelle="Créer"
      onValider={() => void valider()}
      onFermer={onFermer}
      desactive={!config || !brancheEffective}
      occupe={occupe}
      classe="wt-nouveau"
    >
      {erreurChargement ? <div className="git-panel__dialog-error" role="alert">{erreurChargement}</div> : null}
      <label className="git-panel__dialog-field" htmlFor="wt-titre">
        <span className="git-panel__dialog-label">Tâche</span>
        <input
          id="wt-titre"
          data-autofocus
          className="git-panel__dialog-input"
          placeholder="Ex. : corriger le calcul du panier"
          value={titre}
          maxLength={120}
          onChange={(e) => setTitre(e.target.value)}
        />
      </label>
      <label className="git-panel__dialog-field" htmlFor="wt-branche">
        <span className="git-panel__dialog-label">Branche</span>
        <input
          id="wt-branche"
          className="git-panel__dialog-input"
          placeholder="nom-de-la-branche"
          value={brancheEffective}
          onChange={(e) => {
            setBrancheTouchee(true);
            setBranche(e.target.value);
          }}
        />
        {config && brancheEffective ? (
          <span className="wt-indice" title="Dossier du worktree">{`${config.nom}-worktrees/${slug(brancheEffective)}`}</span>
        ) : null}
      </label>
      <label className="git-panel__dialog-field" htmlFor="wt-base">
        <span className="git-panel__dialog-label">Partir de</span>
        <select id="wt-base" className="git-panel__dialog-select" value={base} onChange={(e) => setBase(e.target.value)} disabled={!config}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <label className="git-panel__dialog-check">
        <input type="checkbox" checked={retenir} onChange={(e) => setRetenir(e.target.checked)} />
        <span>Toujours partir de cette branche dans ce dépôt</span>
      </label>
      {cfg ? (
        <div className="wt-projet" data-fichier={cfg.fichiers.length ? "oui" : "non"}>
          {cfg.erreurs.map((m) => (
            <div key={m} className="git-panel__dialog-error">{m}</div>
          ))}
          {cfg.fichiers.length === 0 ? (
            <div className="wt-projet__ligne">
              <span>Pas de worktrees.toml : rien n'est partagé ni lancé.</span>
              <button type="button" className="git-panel__dialog-btn wt-lien" data-action="creer-config" onClick={() => void creerFichier()}>
                Créer le fichier
              </button>
            </div>
          ) : null}
          {partages.length ? <div className="wt-projet__ligne" title={partages.join(", ")}>Partage : {partages.join(", ")}</div> : null}
          {commandes ? (
            <>
              <label className="git-panel__dialog-check" data-action="lancer-commandes">
                <input type="checkbox" checked={lancer} onChange={(e) => setLancer(e.target.checked)} />
                <span>{approuve ? "Lancer les commandes du projet" : "Lancer ces commandes (nouvelles : lisez-les)"}</span>
              </label>
              <pre className="wt-commandes">{texteCommandes(cfg.scriptCreation, cfg.terminaux, cfg.scriptSuppression)}</pre>
            </>
          ) : null}
        </div>
      ) : null}
      {erreur ? <div className="git-panel__dialog-error" role="alert">{erreur}</div> : null}
    </Dialogue>
  );
}

export function texteCommandes(script: string | null, terminaux: TerminalDefaut[], suppression: string | null = null): string {
  const lignes: string[] = [];
  if (script) lignes.push("Préparation :", ...script.split("\n").map((l) => `  ${l}`));
  const avecCommande = terminaux.filter((t) => t.commande);
  if (avecCommande.length) lignes.push("Terminaux :", ...avecCommande.map((t) => `  ${t.nom} : ${t.commande}`));
  if (suppression) lignes.push("À la suppression :", ...suppression.split("\n").map((l) => `  ${l}`));
  return lignes.join("\n");
}

// Worktrees — confirmations de la liste : supprimer ou archiver (en lot),
// lien vers une PR ou une issue, branche de départ du dépôt.
import { useEffect, useState } from "react";
import { Dialogue } from "./Dialogue";
import { texteErreur, worktreesApi, type ConfigDepot, type WorktreeInfo } from "./worktreesApi";
import { commandesApprouvees, lireReglages, nomDe, urlValide } from "./logique";

const stockage = () => (typeof window !== "undefined" ? window.localStorage : null);

export type ChoixSuppression = {
  supprimerBranches: boolean;
  forcer: boolean;
  lancerScript: boolean;
  empreinte: string | null;
};

/** Supprimer ou archiver des worktrees (un ou plusieurs, d'un même dépôt ou non). */
export function ConfirmationSuppression({
  mode,
  depot,
  worktrees,
  onFermer,
  onConfirmer,
}: {
  mode: "supprimer" | "archiver";
  /** Dépôt du premier worktree (pour lire son script de suppression). */
  depot: string;
  worktrees: WorktreeInfo[];
  onFermer: () => void;
  onConfirmer: (choix: ChoixSuppression) => Promise<void>;
}) {
  const [config, setConfig] = useState<ConfigDepot | null>(null);
  const [supprimerBranches, setSupprimerBranches] = useState(false);
  const [forcer, setForcer] = useState(false);
  const [lancer, setLancer] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    let vivant = true;
    worktreesApi
      .config(depot)
      .then((c) => {
        if (!vivant) return;
        setConfig(c);
        setLancer(Boolean(c.config.scriptSuppression) && commandesApprouvees(lireReglages(stockage()), c.depot, c.config.empreinte));
      })
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, [depot]);
  const modifies = worktrees.filter((w) => (w.modifies ?? 0) > 0);
  const n = worktrees.length;
  const nom = n === 1 ? `« ${worktrees[0].nom} »` : `${n} worktrees`;
  const script = config?.config.scriptSuppression ?? null;
  const valider = async () => {
    setOccupe(true);
    setErreur(null);
    try {
      await onConfirmer({ supprimerBranches, forcer, lancerScript: lancer && Boolean(script), empreinte: lancer ? config?.config.empreinte ?? null : null });
      onFermer();
    } catch (e) {
      setErreur(texteErreur(e));
      setOccupe(false);
    }
  };
  return (
    <Dialogue
      titre={mode === "supprimer" ? `Supprimer ${nom} ?` : `Archiver ${nom} ?`}
      description={
        mode === "supprimer"
          ? "Le dossier est retiré du disque. La branche est gardée, sauf si vous cochez ci-dessous."
          : "Le dossier est retiré, la branche est gardée : « Restaurer » le recrée."
      }
      libelle={mode === "supprimer" ? "Supprimer" : "Archiver"}
      danger={mode === "supprimer"}
      onValider={() => void valider()}
      onFermer={onFermer}
      occupe={occupe}
      classe="wt-confirmation"
    >
      <ul className="wt-confirmation__liste">
        {worktrees.map((w) => (
          <li key={w.dossier} title={w.dossier}>
            <span className="wt-confirmation__nom">{w.nom}</span>
            <span className="wt-confirmation__branche">{w.branche ?? "détachée"}</span>
            {(w.modifies ?? 0) > 0 ? <span className="wt-confirmation__alerte">{w.modifies} modif.</span> : null}
          </li>
        ))}
      </ul>
      {mode === "supprimer" ? (
        <label className="git-panel__dialog-check">
          <input type="checkbox" checked={supprimerBranches} onChange={(e) => setSupprimerBranches(e.target.checked)} />
          <span>Supprimer aussi les branches (fusionnées seulement)</span>
        </label>
      ) : null}
      {modifies.length ? (
        <label className="git-panel__dialog-check">
          <input type="checkbox" checked={forcer} onChange={(e) => setForcer(e.target.checked)} />
          <span>Retirer même les fichiers modifiés ({modifies.length})</span>
        </label>
      ) : null}
      {script ? (
        <>
          <label className="git-panel__dialog-check">
            <input type="checkbox" checked={lancer} onChange={(e) => setLancer(e.target.checked)} />
            <span>Lancer le script de suppression avant</span>
          </label>
          <pre className="wt-commandes">{script}</pre>
        </>
      ) : null}
      {erreur ? <div className="git-panel__dialog-error" role="alert">{erreur}</div> : null}
    </Dialogue>
  );
}

/** Lien vers une PR ou une issue (adresse saisie), affiché sur la ligne du worktree. */
export function DialogueLien({
  worktree,
  lien,
  onFermer,
  onEnregistrer,
}: {
  worktree: WorktreeInfo;
  lien: string | undefined;
  onFermer: () => void;
  onEnregistrer: (url: string) => void;
}) {
  const [url, setUrl] = useState(lien ?? "");
  const valide = !url.trim() || urlValide(url);
  return (
    <Dialogue
      titre="Lien vers une PR ou une issue"
      description={<>Pour le worktree <strong className="git-panel__dialog-strong">{worktree.nom}</strong>. Vide : pas de lien.</>}
      libelle="Enregistrer"
      desactive={!valide}
      onValider={() => {
        onEnregistrer(url.trim());
        onFermer();
      }}
      onFermer={onFermer}
      classe="wt-dialogue-lien"
    >
      <label className="git-panel__dialog-field" htmlFor="wt-lien">
        <span className="git-panel__dialog-label">Adresse</span>
        <input
          id="wt-lien"
          data-autofocus
          className="git-panel__dialog-input"
          placeholder="https://github.com/…/pull/12"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </label>
      {!valide ? <div className="git-panel__dialog-error">Adresse http ou https attendue.</div> : null}
    </Dialogue>
  );
}

/** Branche de départ des nouveaux worktrees de ce dépôt (réglage local). */
export function DialogueBase({
  depot,
  base,
  onFermer,
  onEnregistrer,
}: {
  depot: string;
  base: string | undefined;
  onFermer: () => void;
  onEnregistrer: (base: string) => void;
}) {
  const [config, setConfig] = useState<ConfigDepot | null>(null);
  const [choix, setChoix] = useState(base ?? "");
  useEffect(() => {
    let vivant = true;
    worktreesApi
      .config(depot)
      .then((c) => {
        if (!vivant) return;
        setConfig(c);
        setChoix((x) => x || c.config.base || c.branchePrincipale || c.branches[0] || "");
      })
      .catch(() => undefined);
    return () => {
      vivant = false;
    };
  }, [depot]);
  const branches = config ? [...config.branches] : [];
  if (choix && !branches.includes(choix)) branches.unshift(choix);
  return (
    <Dialogue
      titre={`Branche de départ : ${nomDe(depot)}`}
      description={`Les nouveaux worktrees partent de cette branche (par défaut : ${config?.branchePrincipale ?? "la branche principale"}).`}
      libelle="Enregistrer"
      desactive={!choix}
      onValider={() => {
        onEnregistrer(choix);
        onFermer();
      }}
      onFermer={onFermer}
      classe="wt-dialogue-base"
    >
      <label className="git-panel__dialog-field" htmlFor="wt-base-depot">
        <span className="git-panel__dialog-label">Partir de</span>
        <select id="wt-base-depot" className="git-panel__dialog-select" value={choix} onChange={(e) => setChoix(e.target.value)}>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
    </Dialogue>
  );
}

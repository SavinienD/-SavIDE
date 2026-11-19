// bascule — Réglages > Fournisseurs : bascule de fournisseur (éteinte par défaut).
// Pour chaque fournisseur, l'utilisateur choisit lui-même ses fournisseurs de secours, dans
// l'ordre : aucune bascule vers un fournisseur (ou une clé) qu'il n'a pas désigné pour celui-là.
// Enregistré dans `repl-settings.json` (champ `bascule`) ; les autres réglages restent intacts.
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import {
  ajouterSecours,
  BASCULE_ETEINTE,
  lireBascule,
  monterSecours,
  retirerSecours,
  secoursPossibles,
  type BasculeReglage,
} from "./bascule";

type Reglages = Record<string, unknown> & { bascule?: unknown };

export function BasculePanel() {
  const [reglages, setReglages] = useState<Reglages | null>(null);
  const [bascule, setBascule] = useState<BasculeReglage>(BASCULE_ETEINTE);
  const [fournisseurs, setFournisseurs] = useState<string[]>([]);
  const [principal, setPrincipal] = useState("");
  const [statut, setStatut] = useState<string | null>(null);

  useEffect(() => {
    let annule = false;
    void Promise.all([
      invoke<Reglages>("repl_settings_get"),
      invoke<string[]>("list_configured_model_providers").catch(() => [] as string[]),
    ])
      .then(([lus, ids]) => {
        if (annule) return;
        setReglages(lus);
        setBascule(lireBascule(lus.bascule));
        setFournisseurs(ids);
        setPrincipal((p) => p || ids[0] || "");
      })
      .catch((e) => !annule && setStatut(`Lecture impossible : ${String(e)}`));
    return () => {
      annule = true;
    };
  }, []);

  const enregistrer = useCallback(
    async (suivant: BasculeReglage) => {
      if (!reglages) return;
      setBascule(suivant);
      try {
        const lus = await invoke<Reglages>("repl_settings_save", { input: { settings: { ...reglages, bascule: suivant } } });
        setReglages(lus);
        setBascule(lireBascule(lus.bascule));
        setStatut("Enregistré : appliqué dès le prochain appel au modèle.");
      } catch (e) {
        setStatut(`Enregistrement impossible : ${String(e)}`);
      }
    },
    [reglages],
  );

  if (!reglages) return statut ? <p className="axe-providers__hint">{statut}</p> : null;
  const tous = [...new Set([...fournisseurs, ...Object.keys(bascule.secours)])].sort();
  const choix = principal || tous[0] || "";
  const possibles = secoursPossibles(bascule, choix, tous);

  return (
    <div className="axe-providers__card axe-bascule" data-open="true">
      <div className="axe-providers__body">
        <div className="axe-providers__models-head">
          <strong>Bascule de fournisseur</strong>
          {statut && <span className="settings-pane__status" data-tone="ok">{statut}</span>}
        </div>
        <span className="axe-providers__hint">
          Si un fournisseur reste en panne après ses nouveaux essais, ou atteint la limite de son abonnement, le
          travail continue avec le même modèle chez un fournisseur de secours choisi ici pour lui. Un avis le dit
          dans la conversation. Seuls les secours listés pour ce fournisseur servent : une clé d'entreprise ne
          remplace un compte personnel (ni l'inverse) que si vous l'ajoutez vous-même.
        </span>
        <label className="axe-providers__check">
          <input
            type="checkbox"
            data-champ="bascule-active"
            checked={bascule.enabled}
            onChange={(e) => void enregistrer({ ...bascule, enabled: e.target.checked })}
          />
          Activer la bascule
        </label>
        <div className="axe-providers__saisie">
          <label>
            <span className="axe-providers__champ-titre">Fournisseur</span>
            <select className="axe-providers__select" value={choix} onChange={(e) => setPrincipal(e.target.value)}>
              {tous.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="axe-providers__champ-titre">Ajouter un secours</span>
            <select
              className="axe-providers__select"
              data-champ="bascule-ajout"
              value=""
              disabled={!choix || possibles.length === 0}
              onChange={(e) => e.target.value && void enregistrer(ajouterSecours(bascule, choix, e.target.value))}
            >
              <option value="">{possibles.length === 0 ? "Aucun autre fournisseur" : "Choisir…"}</option>
              {possibles.map((id) => (
                <option key={id} value={id}>{id}</option>
              ))}
            </select>
          </label>
        </div>
        {Object.entries(bascule.secours).map(([fournisseur, liste]) => (
          <div key={fournisseur} className="axe-providers__models-head" data-fournisseur={fournisseur}>
            <span className="axe-providers__name">{fournisseur}</span>
            <Icon icon="solar:arrow-right-linear" width={13} height={13} />
            {liste.map((id, rang) => (
              <span key={id} className="axe-providers__kind">
                {rang + 1}. {id}
                {rang > 0 && (
                  <button
                    type="button"
                    className="axe-providers__icon-btn"
                    title="Essayer plus tôt"
                    aria-label={`Monter ${id}`}
                    onClick={() => void enregistrer(monterSecours(bascule, fournisseur, id))}
                  >
                    <Icon icon="solar:alt-arrow-up-linear" width={12} height={12} />
                  </button>
                )}
                <button
                  type="button"
                  className="axe-providers__icon-btn"
                  title="Retirer ce secours"
                  aria-label={`Retirer ${id}`}
                  onClick={() => void enregistrer(retirerSecours(bascule, fournisseur, id))}
                >
                  <Icon icon="solar:close-circle-linear" width={12} height={12} />
                </button>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

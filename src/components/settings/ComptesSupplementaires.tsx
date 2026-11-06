// Réglages > Fournisseurs : comptes ajoutés d'un fournisseur à abonnement
// (deuxième compte Claude, deuxième compte ChatGPT…) sous la carte du compte principal :
// e-mail et offre de chacun, « Déconnecter » (ce compte seul), « Ajouter un compte » (connexion
// OAuth dans le navigateur, jetons gardés à part ; le même compte reconnecté remplace l'ancien).
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { api } from "../../lib/ipc";
import { PROVIDERS_CHANGED_EVENT } from "../../axe/providers";
import { libelleOffre } from "../../lib/comptesFournisseurs";
import type { CompteModele } from "../../lib/comptesModeles";

type Props = {
  /** « anthropic » ou « openai ». */
  base: "anthropic" | "openai";
  /** Compte principal connecté (« Ajouter un compte » n'a de sens qu'après lui). */
  principalConnecte: boolean;
};

const COMMANDES = {
  anthropic: { start: "start_anthropic_oauth_login", status: "get_anthropic_provider_status", cancel: "cancel_anthropic_oauth_login" },
  openai: { start: "start_openai_oauth_login", status: "get_openai_provider_status", cancel: "cancel_openai_oauth_login" },
} as const;

export function ComptesSupplementaires({ base, principalConnecte }: Props) {
  const [comptes, setComptes] = useState<CompteModele[]>([]);
  const [enConnexion, setEnConnexion] = useState(false);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const minuterie = useRef<number | null>(null);

  const charger = useCallback(async () => {
    try {
      const liste = await invoke<CompteModele[]>("list_provider_accounts");
      setComptes((Array.isArray(liste) ? liste : []).filter((c) => c.base === base && c.providerId !== base));
    } catch {
      setComptes([]);
    }
  }, [base]);

  useEffect(() => {
    void charger();
    const maj = () => void charger();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, maj);
    return () => {
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, maj);
      if (minuterie.current !== null) window.clearInterval(minuterie.current);
    };
  }, [charger]);

  const finConnexion = useCallback(
    (erreur: string | null) => {
      if (minuterie.current !== null) window.clearInterval(minuterie.current);
      minuterie.current = null;
      setEnConnexion(false);
      setMessage(erreur);
      void charger();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    },
    [charger],
  );

  const ajouter = async () => {
    setMessage(null);
    try {
      const login = await invoke<{ authUrl: string }>(COMMANDES[base].start, { nouveauCompte: true });
      setEnConnexion(true);
      await api.openExternalUrl(login.authUrl);
      minuterie.current = window.setInterval(async () => {
        try {
          const s = await invoke<{ connectionState?: string; error?: string | null }>(COMMANDES[base].status);
          if (s?.connectionState === "connecting") return;
          finConnexion(s?.connectionState === "error" ? s.error ?? "Connexion impossible" : null);
        } catch (err) {
          finConnexion(err instanceof Error ? err.message : String(err));
        }
      }, 1200);
    } catch (err) {
      finConnexion(err instanceof Error ? err.message : String(err));
    }
  };

  const annuler = async () => {
    try {
      await invoke(COMMANDES[base].cancel);
    } finally {
      finConnexion(null);
    }
  };

  const deconnecter = async (providerId: string) => {
    setOccupe(providerId);
    setMessage(null);
    try {
      const liste = await invoke<CompteModele[]>("disconnect_provider_account", { providerId });
      setComptes((Array.isArray(liste) ? liste : []).filter((c) => c.base === base && c.providerId !== base));
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setOccupe(null);
    }
  };

  if (!principalConnecte && comptes.length === 0) return null;
  return (
    <div className="settings-pane__comptes" data-comptes={base}>
      {comptes.map((c) => {
        const offre = libelleOffre(c.plan ?? null);
        return (
          <div key={c.providerId} className="settings-pane__compte" data-compte-ajoute={c.providerId}>
            <Icon icon="solar:user-circle-linear" width={14} height={14} />
            <span className="settings-pane__compte-email" title={c.email ?? c.providerId}>
              {c.email ?? `Compte ${c.providerId.split("~")[1] ?? ""}`}
            </span>
            {offre && <span className="settings-pane__compte-offre">{offre}</span>}
            <button
              type="button"
              className="settings-pane__btn"
              data-action="deconnecter-compte"
              data-compte={c.providerId}
              disabled={occupe !== null}
              onClick={() => void deconnecter(c.providerId)}
              title="Déconnecter ce compte seulement"
              aria-label={`Déconnecter ${c.email ?? c.providerId}`}
            >
              <Icon icon={occupe === c.providerId ? "solar:refresh-linear" : "solar:logout-2-linear"} width={13} height={13} />
            </button>
          </div>
        );
      })}
      <div className="settings-pane__comptes-actions">
        {enConnexion ? (
          <>
            <span className="settings-pane__compte-attente">En attente de la confirmation dans le navigateur…</span>
            <button type="button" className="settings-pane__btn" onClick={() => void annuler()}>
              <Icon icon="solar:close-circle-linear" width={13} height={13} />
              <span>Annuler</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className="settings-pane__btn"
            data-action="ajouter-compte"
            data-fournisseur={base}
            title="Ajouter un compte : connecter un autre compte du même fournisseur (il apparaîtra dans le choix du modèle)"
            aria-label="Ajouter un compte"
            onClick={() => void ajouter()}
          >
            <Icon icon="solar:user-plus-linear" width={13} height={13} />
            <span>Ajouter</span>
          </button>
        )}
      </div>
      {message && <div className="settings-pane__provider-error">{message}</div>}
    </div>
  );
}

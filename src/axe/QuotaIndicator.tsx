// Quotas des abonnements dans la barre du haut : tous les comptes Claude et ChatGPT connectés.
// Vue compacte (la fenêtre la plus pleine), détail au clic (par compte : fenêtres en % utilisé ou
// restant, heure de réinitialisation), réglages (affichage, seuil d'alerte) et alerte
// `ide-notification` au seuil. Lit l'IPC `provider_quota` toutes les 5 min ; masqué sans quota.
// Logique : quotas.ts.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PROVIDERS_CHANGED_EVENT } from "./providers";
import {
  EVENEMENT_REGLAGES_QUOTA,
  alertesQuota,
  alertesVues,
  bornerSeuil,
  comptesAvecQuota,
  delaiAvant,
  ecrireReglagesQuota,
  finFenetre,
  heureReinitialisation,
  lireReglagesQuota,
  nomCompte,
  noterAlertesVues,
  partiesCompactes,
  textePourcent,
  ton,
  valeurAffichee,
  type ModeQuota,
  type QuotaReport,
  type ReglagesQuota,
} from "./quotas";
import "./quotas.css";

export type { QuotaReport } from "./quotas";

const POLL_MS = 5 * 60_000;
const NB = "\u00a0";

export function fetchProviderQuota(force = false): Promise<QuotaReport> {
  return invoke<QuotaReport>("provider_quota", { input: { force } });
}

function stockage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Fenêtre principale : elle seule signale les seuils (pas de doublon avec une fenêtre détachée). */
function fenetrePrincipale(): boolean {
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return false;
  }
}

/** Alertes de seuil pas encore signalées pour cette période (contrat commun `ide-notification`). */
function signalerSeuils(report: QuotaReport, seuil: number) {
  if (!fenetrePrincipale()) return;
  const s = stockage();
  const alertes = alertesQuota(report, seuil, alertesVues(s));
  if (alertes.length === 0) return;
  noterAlertesVues(s, alertes.map((a) => a.cle));
  for (const a of alertes) {
    window.dispatchEvent(new CustomEvent("ide-notification", { detail: { genre: "info", titre: a.titre, texte: a.texte } }));
  }
}

export function QuotaIndicator() {
  const [report, setReport] = useState<QuotaReport | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reglages, setReglages] = useState<ReglagesQuota>(() => lireReglagesQuota(stockage()));
  const [maintenant, setMaintenant] = useState(() => Date.now());
  // Seuil en cours de saisie : appliqué à la sortie du champ ou sur Entrée (pas à chaque chiffre).
  const [brouillonSeuil, setBrouillonSeuil] = useState<string | null>(null);
  // Indicateur près du bord droit de la fenêtre : le détail s'ouvre vers la gauche.
  const [versGauche, setVersGauche] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const seuilRef = useRef(reglages.seuil);
  seuilRef.current = reglages.seuil;

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const lu = await fetchProviderQuota(force);
      setReport(lu);
      setMaintenant(Date.now());
      signalerSeuils(lu, seuilRef.current);
    } catch {
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    const refresh = () => void load();
    const relire = () => setReglages(lireReglagesQuota(stockage()));
    window.addEventListener(PROVIDERS_CHANGED_EVENT, refresh);
    window.addEventListener(EVENEMENT_REGLAGES_QUOTA, relire);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(PROVIDERS_CHANGED_EVENT, refresh);
      window.removeEventListener(EVENEMENT_REGLAGES_QUOTA, relire);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const tic = window.setInterval(() => setMaintenant(Date.now()), 30_000);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.clearInterval(tic);
    };
  }, [open]);

  const changer = (suite: ReglagesQuota) => {
    setReglages(suite);
    ecrireReglagesQuota(stockage(), suite);
    window.dispatchEvent(new Event(EVENEMENT_REGLAGES_QUOTA));
    if (report && suite.seuil !== reglages.seuil) signalerSeuils(report, suite.seuil);
  };

  const validerSeuil = () => {
    if (brouillonSeuil === null) return;
    const seuil = bornerSeuil(brouillonSeuil);
    setBrouillonSeuil(null);
    if (seuil !== reglages.seuil) changer({ ...reglages, seuil });
  };

  const basculer = () => {
    const r = rootRef.current?.getBoundingClientRect();
    setVersGauche(!!r && r.left + 308 > window.innerWidth);
    setOpen((v) => !v);
  };

  const fermer = () => {
    setOpen(false);
    pillRef.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      fermer();
    }
  };

  const comptes = comptesAvecQuota(report);
  if (comptes.length === 0) return null;
  const compact = partiesCompactes(report, reglages, maintenant);
  const enErreur = comptes.some((p) => p.error);
  const mode = reglages.mode;
  const choix: [ModeQuota, string][] = [
    ["utilise", "% utilisé"],
    ["restant", "% restant"],
  ];

  return (
    <div className="axe-quota" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={pillRef}
        className="axe-quota__pill"
        data-tone={compact?.ton ?? (enErreur ? "error" : "ok")}
        onClick={basculer}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={mode === "restant" ? "Quotas des abonnements (part restante)" : "Quotas des abonnements (part utilisée)"}
      >
        <span className="axe-quota__dot" />
        {compact ? (
          <span className="axe-quota__compact">
            {compact.compte && <span className="axe-quota__compte">{compact.compte}</span>}
            <span>
              {compact.fenetre} {compact.valeur}
            </span>
            {compact.heure && <span className="axe-quota__heure">· {compact.heure}</span>}
          </span>
        ) : (
          <span>Quota</span>
        )}
      </button>

      {open && (
        <div className="axe-quota__popover" data-cote={versGauche ? "gauche" : "droite"} role="dialog" aria-label="Quotas des abonnements">
          <div className="axe-quota__top">
            <strong>Quotas</strong>
            <button type="button" className="axe-quota__action" disabled={loading} onClick={() => void load(true)}>
              {loading ? "…" : "Actualiser"}
            </button>
          </div>
          <div className="axe-quota__reglages">
            <div className="axe-quota__choix" role="group" aria-label="Affichage des quotas">
              {choix.map(([valeur, libelle]) => (
                <button
                  key={valeur}
                  type="button"
                  aria-pressed={mode === valeur}
                  onClick={() => changer({ ...reglages, mode: valeur })}
                >
                  {libelle}
                </button>
              ))}
            </div>
            <label className="axe-quota__seuil">
              <span>Alerte à</span>
              <input
                type="number"
                min={1}
                max={100}
                step={5}
                value={brouillonSeuil ?? String(reglages.seuil)}
                aria-label="Seuil d'alerte en pourcentage utilisé"
                onChange={(e) => setBrouillonSeuil(e.target.value)}
                onBlur={validerSeuil}
                onKeyDown={(e) => {
                  if (e.key === "Enter") validerSeuil();
                }}
              />
              <span>%{NB}utilisés</span>
            </label>
          </div>
          {comptes.map((p) => (
            <section key={p.provider} className="axe-quota__provider" aria-label={nomCompte(p)}>
              <div className="axe-quota__head">
                <span className="axe-quota__nom">{nomCompte(p)}</span>
                {p.account && (
                  <span className="axe-quota__account" title={p.account}>
                    {p.account}
                  </span>
                )}
                {p.plan && <span className="axe-quota__plan">{p.plan}</span>}
              </div>
              {p.error && <div className="axe-quota__error">{p.error}</div>}
              {p.windows.map((w) => {
                const fin = finFenetre(w);
                return (
                <div key={w.id} className="axe-quota__window" data-tone={ton(w, reglages.seuil)}>
                  <div className="axe-quota__row">
                    <span>{w.label}</span>
                    <span>{textePourcent(w.utilization, mode)}</span>
                  </div>
                  <div className="axe-quota__bar">
                    <span style={{ width: `${valeurAffichee(w.utilization, mode)}%` }} />
                    <i
                      className="axe-quota__repere"
                      style={{ left: `${mode === "restant" ? 100 - reglages.seuil : reglages.seuil}%` }}
                      aria-hidden
                    />
                  </div>
                  <div className="axe-quota__meta">
                    {fin ? (
                      <span>
                        Réinitialisation à {heureReinitialisation(fin, maintenant)} ({delaiAvant(fin, maintenant)})
                      </span>
                    ) : null}
                    {w.exhaustsBeforeReset && w.projectedExhaustionMs ? (
                      <span className="axe-quota__alerte">
                        Au rythme actuel, épuisé à {heureReinitialisation(w.projectedExhaustionMs, maintenant)}
                      </span>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

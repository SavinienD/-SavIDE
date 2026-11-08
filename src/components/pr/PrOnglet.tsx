// Onglet PR du panneau Git : PR du dépôt (GitHub, Forgejo / Gitea), détail avec checks,
// revues et commentaires (fichier:ligne), « Envoyer à l'agent », création d'une PR
// (brouillon possible) dont le titre et la description peuvent être rédigés par l'IA.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { consigneChecks, consigneCommentaires, type CommentaireChoisi, type RefPr } from "./consignes";
import {
  dateCourte,
  forgeApi,
  libelleCheck,
  libelleRevue,
  nomForge,
  type Check,
  type ForgeEtat,
  type PrDetail,
  type PrResume,
  type Revue,
} from "./forgeApi";
import { redigerPr } from "./redaction";
import { envoyerALAgent } from "./versAgent";

export type AvisPr = {
  kind: "success" | "error" | "info";
  text: string;
  sticky?: boolean;
  cle?: string;
  details?: string | null;
};

type Props = {
  workspacePath: string;
  actif: boolean;
  branches: string[];
  brancheCourante: string | null;
  branchePrincipale: string | null;
  notifier: (avis: AvisPr) => void;
  ouvrirUrl: (url: string) => void;
};

type Vue = { genre: "liste" } | { genre: "detail"; numero: number } | { genre: "nouvelle" };

function erreurTexte(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === "string" ? err : JSON.stringify(err);
}

export function avisLivraison(livraison: string, quoi: string): AvisPr {
  return livraison === "saisie"
    ? { kind: "info", cle: "consigne-saisie", text: `${quoi} mis dans la conversation : relisez puis Entrée.` }
    : {
        kind: "info",
        cle: "consigne-copiee",
        sticky: true,
        text: "Aucune conversation ouverte ici : la consigne est copiée dans le presse-papiers.",
      };
}

/** En-tête commun des onglets PR et Issues : forge, dépôt, jeton. */
export function useForge(workspacePath: string, actif: boolean) {
  const [etat, setEtat] = useState<ForgeEtat | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!actif) return;
    let vivant = true;
    forgeApi.etat(workspacePath).then(
      (e) => vivant && (setEtat(e), setErreur(null)),
      (err) => vivant && setErreur(erreurTexte(err)),
    );
    return () => {
      vivant = false;
    };
  }, [actif, workspacePath, version]);
  const relire = useCallback(() => setVersion((v) => v + 1), []);
  return { etat, erreur, relire };
}

export function EnteteForge({
  etat,
  erreur,
  onJeton,
  ouvrirUrl,
}: {
  etat: ForgeEtat | null;
  erreur: string | null;
  onJeton: () => void;
  ouvrirUrl: (url: string) => void;
}) {
  const [saisie, setSaisie] = useState(false);
  const [jeton, setJeton] = useState("");
  const [occupe, setOccupe] = useState(false);
  const [echec, setEchec] = useState<string | null>(null);
  if (erreur) return <div className="git-panel__empty git-pr__erreur">{erreur}</div>;
  if (!etat) return <div className="git-panel__empty">Lecture du dépôt distant…</div>;
  const d = etat.depot;
  if (!d || etat.message) return <div className="git-panel__empty git-pr__erreur">{etat.message}</div>;
  const enregistrer = async (valeur: string | null) => {
    setOccupe(true);
    setEchec(null);
    try {
      await forgeApi.jeton(d.hote, valeur);
      setJeton("");
      setSaisie(false);
      onJeton();
    } catch (err) {
      setEchec(erreurTexte(err));
    } finally {
      setOccupe(false);
    }
  };
  const source = etat.jetonEnregistre ? "jeton enregistré" : etat.jeton ? "jeton de gh" : "sans jeton : lecture publique";
  return (
    <div className="git-pr__forge">
      <div className="git-pr__forge-ligne">
        <span className="git-pr__forge-nom" title={d.urlWeb}>
          {nomForge(d.genre)} · {d.proprietaire}/{d.nom}
        </span>
        <span className="git-pr__forge-jeton" data-jeton={etat.jeton ? "oui" : "non"}>{source}</span>
        <button
          type="button"
          className="git-panel__head-btn"
          data-action="jeton"
          onClick={() => setSaisie((v) => !v)}
          title={etat.jetonEnregistre ? "Remplacer ou retirer le jeton" : "Enregistrer un jeton d'accès"}
          aria-label="Jeton d'accès"
          aria-expanded={saisie}
        >
          <Icon icon="solar:key-linear" width={13} height={13} />
        </button>
        <button
          type="button"
          className="git-panel__head-btn"
          onClick={() => ouvrirUrl(d.urlWeb)}
          title={`Ouvrir ${d.urlWeb}`}
          aria-label="Ouvrir le dépôt dans le navigateur"
        >
          <Icon icon="solar:arrow-right-up-linear" width={13} height={13} />
        </button>
      </div>
      {(saisie || (!etat.jeton && d.genre !== "github")) && (
        <div className="git-pr__jeton">
          <span className="git-pr__note">
            {d.genre === "github"
              ? "Connectez GitHub CLI (gh auth login) ou collez un jeton (droits : contenu, PR, issues, actions en lecture)."
              : d.genre === "gitlab"
                ? `Jeton d'accès de ${d.hote} : Préférences > Jetons d'accès (accès à l'API).`
                : `Jeton d'accès de ${d.hote} : Paramètres > Applications > Générer un jeton (dépôt et issues).`}
          </span>
          <div className="git-pr__jeton-ligne">
            <input
              type="password"
              className="git-panel__dialog-input git-pr__jeton-champ"
              placeholder="Jeton d'accès"
              autoComplete="off"
              spellCheck={false}
              value={jeton}
              onChange={(e) => setJeton(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && jeton.trim()) void enregistrer(jeton);
              }}
              aria-label={`Jeton d'accès de ${d.hote}`}
            />
            <button
              type="button"
              className="git-panel__action git-pr__jeton-btn"
              data-action="enregistrer-jeton"
              disabled={occupe || !jeton.trim()}
              onClick={() => void enregistrer(jeton)}
            >
              Enregistrer
            </button>
            {etat.jetonEnregistre && (
              <button
                type="button"
                className="git-pr__bouton"
                disabled={occupe}
                onClick={() => void enregistrer(null)}
              >
                Retirer
              </button>
            )}
          </div>
          {echec && <div className="git-panel__dialog-error">{echec}</div>}
        </div>
      )}
    </div>
  );
}

function Pastille({ etat }: { etat: Check["etat"] }) {
  return <span className="git-pr__pastille" data-etat={etat} title={libelleCheck(etat)} aria-label={libelleCheck(etat)} />;
}

export function PrOnglet({
  workspacePath,
  actif,
  branches,
  brancheCourante,
  branchePrincipale,
  notifier,
  ouvrirUrl,
}: Props) {
  const { etat, erreur, relire } = useForge(workspacePath, actif);
  const [vue, setVue] = useState<Vue>({ genre: "liste" });
  const [toutes, setToutes] = useState(false);
  const [prs, setPrs] = useState<PrResume[] | null>(null);
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const seq = useRef(0);
  const disponible = Boolean(etat?.depot && !etat.message);

  const chargerListe = useCallback(async () => {
    const n = ++seq.current;
    setOccupe("liste");
    try {
      const liste = await forgeApi.prs(workspacePath, toutes);
      if (n === seq.current) {
        setPrs(liste);
        setErreurListe(null);
      }
    } catch (err) {
      if (n === seq.current) setErreurListe(erreurTexte(err));
    } finally {
      if (n === seq.current) setOccupe(null);
    }
  }, [toutes, workspacePath]);

  useEffect(() => {
    setVue({ genre: "liste" });
    setPrs(null);
  }, [workspacePath]);

  useEffect(() => {
    if (actif && disponible && vue.genre === "liste") void chargerListe();
  }, [actif, disponible, vue.genre, chargerListe]);

  return (
    <div className="git-pr" data-vue={vue.genre}>
      <EnteteForge etat={etat} erreur={erreur} onJeton={relire} ouvrirUrl={ouvrirUrl} />
      {disponible && vue.genre === "liste" && (
        <section className="git-panel__section">
          <div className="git-panel__section-head">
            <span className="git-panel__section-title">
              <span>Pull requests</span>
              {prs && prs.length > 0 && <span className="git-panel__count">{prs.length}</span>}
            </span>
            <span className="git-panel__section-actions">
              <button
                type="button"
                className="git-panel__section-link"
                data-action="toutes"
                onClick={() => setToutes((v) => !v)}
                aria-pressed={toutes}
              >
                {toutes ? "Ouvertes seulement" : "Toutes"}
              </button>
              <button
                type="button"
                className="git-panel__head-btn"
                onClick={() => void chargerListe()}
                disabled={occupe !== null}
                title="Actualiser"
                aria-label="Actualiser les PR"
              >
                {occupe === "liste" ? (
                  <span className="git-panel__spinner git-panel__spinner--inline" />
                ) : (
                  <Icon icon="solar:refresh-linear" width={13} height={13} />
                )}
              </button>
              <button
                type="button"
                className="git-panel__head-btn"
                data-action="nouvelle-pr"
                onClick={() => setVue({ genre: "nouvelle" })}
                title="Nouvelle PR depuis la branche actuelle"
                aria-label="Nouvelle PR"
              >
                <Icon icon="solar:add-square-linear" width={15} height={15} />
              </button>
            </span>
          </div>
          {erreurListe ? (
            <div className="git-panel__empty git-pr__erreur">{erreurListe}</div>
          ) : !prs ? (
            <div className="git-panel__empty">Lecture des PR…</div>
          ) : prs.length === 0 ? (
            <div className="git-panel__empty">{toutes ? "Aucune PR." : "Aucune PR ouverte."}</div>
          ) : (
            <div className="git-panel__rows">
              {prs.map((pr) => (
                <button
                  key={pr.numero}
                  type="button"
                  className="git-panel__row git-pr__ligne"
                  data-numero={pr.numero}
                  data-courante={pr.branche === brancheCourante ? "true" : "false"}
                  onClick={() => setVue({ genre: "detail", numero: pr.numero })}
                  title={pr.titre}
                >
                  <span className="git-pr__numero">#{pr.numero}</span>
                  <span className="git-pr__ligne-corps">
                    <span className="git-pr__ligne-titre">{pr.titre}</span>
                    <span className="git-pr__ligne-sous">
                      {pr.branche} → {pr.base} · {pr.auteur} · {dateCourte(pr.maj)}
                    </span>
                  </span>
                  {pr.brouillon ? (
                    <span className="git-pr__puce">brouillon</span>
                  ) : pr.etat !== "ouverte" ? (
                    <span className="git-pr__puce" data-etat={pr.etat}>{pr.etat}</span>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
      {disponible && vue.genre === "detail" && (
        <DetailPr
          workspacePath={workspacePath}
          numero={vue.numero}
          retour={() => setVue({ genre: "liste" })}
          notifier={notifier}
          ouvrirUrl={ouvrirUrl}
        />
      )}
      {disponible && vue.genre === "nouvelle" && (
        <NouvellePr
          workspacePath={workspacePath}
          branches={branches}
          brancheCourante={brancheCourante}
          branchePrincipale={branchePrincipale}
          brouillonPossible={Boolean(etat?.depot && !etat.message)}
          annuler={() => setVue({ genre: "liste" })}
          creee={(numero) => setVue({ genre: "detail", numero })}
          notifier={notifier}
        />
      )}
    </div>
  );
}

function DetailPr({
  workspacePath,
  numero,
  retour,
  notifier,
  ouvrirUrl,
}: {
  workspacePath: string;
  numero: number;
  retour: () => void;
  notifier: (avis: AvisPr) => void;
  ouvrirUrl: (url: string) => void;
}) {
  const [pr, setPr] = useState<PrDetail | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<string | null>(null);
  const [choisis, setChoisis] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let vivant = true;
    setOccupe("detail");
    forgeApi.pr(workspacePath, numero).then(
      (d) => {
        if (!vivant) return;
        setPr(d);
        setErreur(null);
        setOccupe(null);
      },
      (err) => {
        if (!vivant) return;
        setErreur(erreurTexte(err));
        setOccupe(null);
      },
    );
    return () => {
      vivant = false;
    };
  }, [numero, version, workspacePath]);

  const ref: RefPr | null = pr ? { numero: pr.numero, titre: pr.titre, url: pr.url, branche: pr.branche } : null;
  const echecs = useMemo(() => (pr ? pr.checks.filter((c) => c.etat === "echec") : []), [pr]);

  // Commentaires de lignes, de la conversation et revues avec un texte : tous peuvent partir.
  const elements = useMemo(() => {
    if (!pr) return [];
    const revues = pr.revues
      .filter((r) => r.corps.trim())
      .map((r) => ({
        cle: `revue:${r.id}`,
        auteur: r.auteur,
        corps: r.corps,
        fichier: null as string | null,
        ligne: null as number | null,
        date: r.date,
        url: null as string | null,
        revue: r.etat as Revue["etat"] | null,
      }));
    const commentaires = pr.commentaires.map((c) => ({ cle: `com:${c.id}`, ...c, revue: null as Revue["etat"] | null }));
    return [...revues, ...commentaires].sort((a, b) => a.date.localeCompare(b.date));
  }, [pr]);

  const envoyerChecks = useCallback(
    async (checks: Check[]) => {
      if (!ref || checks.length === 0) return;
      setOccupe("checks");
      try {
        const lus = await Promise.all(
          checks.slice(0, 5).map(async (c) => ({
            nom: c.nom,
            etat: libelleCheck(c.etat),
            url: c.url,
            journal: c.journal ? await forgeApi.journal(workspacePath, c).catch(() => null) : null,
          })),
        );
        notifier(avisLivraison(envoyerALAgent(consigneChecks(ref, lus), workspacePath), "Checks en échec"));
      } finally {
        setOccupe(null);
      }
    },
    [notifier, ref, workspacePath],
  );

  const envoyerCommentaires = useCallback(() => {
    if (!ref) return;
    const liste: CommentaireChoisi[] = elements
      .filter((e) => choisis.has(e.cle))
      .map((e) => ({ auteur: e.auteur, corps: e.corps, fichier: e.fichier, ligne: e.ligne, url: e.url }));
    if (!liste.length) return;
    notifier(avisLivraison(envoyerALAgent(consigneCommentaires(ref, liste), workspacePath), "Commentaires"));
    setChoisis(new Set());
  }, [choisis, elements, notifier, ref, workspacePath]);

  const basculer = (cle: string) =>
    setChoisis((avant) => {
      const s = new Set(avant);
      if (s.has(cle)) s.delete(cle);
      else s.add(cle);
      return s;
    });

  return (
    <div className="git-pr__detail">
      <div className="git-pr__detail-tete">
        <button type="button" className="git-panel__head-btn" data-action="retour" onClick={retour} title="Retour à la liste" aria-label="Retour à la liste">
          <Icon icon="solar:alt-arrow-left-linear" width={14} height={14} />
        </button>
        <span className="git-pr__detail-titre" title={pr?.titre}>
          #{numero} {pr?.titre ?? ""}
        </span>
        {pr?.brouillon && <span className="git-pr__puce">brouillon</span>}
        <button
          type="button"
          className="git-panel__head-btn"
          onClick={() => setVersion((v) => v + 1)}
          disabled={occupe !== null}
          title="Actualiser"
          aria-label="Actualiser la PR"
        >
          {occupe === "detail" ? (
            <span className="git-panel__spinner git-panel__spinner--inline" />
          ) : (
            <Icon icon="solar:refresh-linear" width={13} height={13} />
          )}
        </button>
        {pr && (
          <button type="button" className="git-panel__head-btn" data-action="web" onClick={() => ouvrirUrl(pr.url)} title={`Ouvrir ${pr.url}`} aria-label="Ouvrir la PR dans le navigateur">
            <Icon icon="solar:arrow-right-up-linear" width={13} height={13} />
          </button>
        )}
      </div>
      {erreur && <div className="git-panel__empty git-pr__erreur">{erreur}</div>}
      {!pr && !erreur && <div className="git-panel__empty">Lecture de la PR…</div>}
      {pr && (
        <>
          <div className="git-pr__detail-sous">
            {pr.branche} → {pr.base} · {pr.auteur} · {pr.etat} · {dateCourte(pr.maj)}
          </div>
          <section className="git-panel__section">
            <div className="git-panel__section-head">
              <span className="git-panel__section-title">
                <span>Checks</span>
                {pr.checks.length > 0 && <span className="git-panel__count">{pr.checks.length}</span>}
              </span>
              {echecs.length > 1 && (
                <span className="git-panel__section-actions">
                  <button type="button" className="git-panel__section-link" data-action="envoyer-echecs" disabled={occupe !== null} onClick={() => void envoyerChecks(echecs)}>
                    Envoyer les échecs à l'agent
                  </button>
                </span>
              )}
            </div>
            {pr.checks.length === 0 ? (
              <div className="git-panel__empty">Aucun check sur le dernier commit.</div>
            ) : (
              <div className="git-panel__rows">
                {pr.checks.map((c) => (
                  <div key={c.id} className="git-panel__row git-pr__check" data-etat={c.etat}>
                    <Pastille etat={c.etat} />
                    <span className="git-pr__ligne-corps">
                      <span className="git-pr__ligne-titre">{c.nom}</span>
                      <span className="git-pr__ligne-sous">{c.detail ? `${libelleCheck(c.etat)} · ${c.detail}` : libelleCheck(c.etat)}</span>
                    </span>
                    <span className="git-pr__actions">
                      {c.etat === "echec" && (
                        <button
                          type="button"
                          className="git-pr__bouton git-pr__bouton--petit"
                          data-action="envoyer-check"
                          disabled={occupe !== null}
                          onClick={() => void envoyerChecks([c])}
                          title={c.journal ? "Envoyer à l'agent avec la fin du journal" : "Envoyer à l'agent"}
                        >
                          {occupe === "checks" ? <span className="git-panel__spinner git-panel__spinner--inline" /> : <Icon icon="solar:plain-2-linear" width={12} height={12} />}
                          <span>Envoyer à l'agent</span>
                        </button>
                      )}
                      {c.url && (
                        <button type="button" className="git-panel__head-btn" onClick={() => ouvrirUrl(c.url!)} title={`Ouvrir ${c.url}`} aria-label={`Ouvrir le check ${c.nom}`}>
                          <Icon icon="solar:arrow-right-up-linear" width={12} height={12} />
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="git-panel__section">
            <div className="git-panel__section-head">
              <span className="git-panel__section-title">
                <span>Revues et commentaires</span>
                {elements.length > 0 && <span className="git-panel__count">{elements.length}</span>}
              </span>
              {elements.length > 0 && (
                <span className="git-panel__section-actions">
                  <button
                    type="button"
                    className="git-panel__section-link"
                    onClick={() =>
                      setChoisis((avant) => (avant.size === elements.length ? new Set() : new Set(elements.map((e) => e.cle))))
                    }
                  >
                    {choisis.size === elements.length ? "Tout désélectionner" : "Tout sélectionner"}
                  </button>
                </span>
              )}
            </div>
            {pr.revues
              .filter((r) => !r.corps.trim() && r.etat !== "commentaire")
              .map((r) => (
                <div key={r.id} className="git-pr__revue" data-etat={r.etat}>
                  {r.auteur} : {libelleRevue(r.etat)}
                </div>
              ))}
            {elements.length === 0 ? (
              <div className="git-panel__empty">Aucun commentaire.</div>
            ) : (
              <div className="git-pr__commentaires">
                {elements.map((e) => (
                  <label key={e.cle} className="git-pr__commentaire" data-cle={e.cle} data-choisi={choisis.has(e.cle) ? "true" : "false"}>
                    <input type="checkbox" checked={choisis.has(e.cle)} onChange={() => basculer(e.cle)} />
                    <span className="git-pr__commentaire-corps">
                      <span className="git-pr__commentaire-tete">
                        {e.fichier ? (
                          <code className="git-pr__lieu">
                            {e.fichier}
                            {e.ligne ? `:${e.ligne}` : ""}
                          </code>
                        ) : e.revue ? (
                          <span className="git-pr__lieu">revue ({libelleRevue(e.revue)})</span>
                        ) : null}
                        <span>
                          {e.auteur} · {dateCourte(e.date)}
                        </span>
                      </span>
                      <span className="git-pr__commentaire-texte">{e.corps}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
            {elements.length > 0 && (
              <div className="git-pr__commit-barre">
                <button
                  type="button"
                  className="git-panel__action"
                  data-action="envoyer-commentaires"
                  disabled={choisis.size === 0}
                  onClick={envoyerCommentaires}
                  title={choisis.size === 0 ? "Cochez les commentaires à traiter" : "Mettre ces commentaires dans la conversation"}
                >
                  Envoyer à l'agent{choisis.size ? ` (${choisis.size})` : ""}
                </button>
              </div>
            )}
          </section>
          {pr.description.trim() && (
            <section className="git-panel__section">
              <div className="git-panel__section-head">
                <span className="git-panel__section-title">
                  <span>Description</span>
                </span>
              </div>
              <div className="git-pr__description">{pr.description}</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function NouvellePr({
  workspacePath,
  branches,
  brancheCourante,
  branchePrincipale,
  brouillonPossible,
  annuler,
  creee,
  notifier,
}: {
  workspacePath: string;
  branches: string[];
  brancheCourante: string | null;
  branchePrincipale: string | null;
  brouillonPossible: boolean;
  annuler: () => void;
  creee: (numero: number) => void;
  notifier: (avis: AvisPr) => void;
}) {
  const bases = branches.filter((b) => b !== brancheCourante);
  const [titre, setTitre] = useState("");
  const [description, setDescription] = useState("");
  const [base, setBase] = useState(
    branchePrincipale && branchePrincipale !== brancheCourante ? branchePrincipale : bases[0] ?? "",
  );
  const [brouillon, setBrouillon] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [occupe, setOccupe] = useState<"rediger" | "creer" | null>(null);
  const [echec, setEchec] = useState<string | null>(null);
  const memeBranche = !brancheCourante || brancheCourante === base;

  const rediger = async () => {
    setOccupe("rediger");
    setEchec(null);
    try {
      const r = await redigerPr(workspacePath, base || null);
      setTitre(r.titre);
      setDescription(r.description);
      setNote(r.note);
    } catch (err) {
      setEchec(erreurTexte(err));
    } finally {
      setOccupe(null);
    }
  };

  const creer = async () => {
    setOccupe("creer");
    setEchec(null);
    try {
      const r = await forgeApi.creerPr(workspacePath, titre.trim(), description.trim(), base, brouillon);
      notifier({ kind: "success", cle: "pr-creee", text: r.message });
      creee(r.numero);
    } catch (err) {
      setEchec(erreurTexte(err));
    } finally {
      setOccupe(null);
    }
  };

  return (
    <div className="git-pr__nouvelle">
      <div className="git-pr__detail-tete">
        <button type="button" className="git-panel__head-btn" data-action="retour" onClick={annuler} title="Retour à la liste" aria-label="Retour à la liste">
          <Icon icon="solar:alt-arrow-left-linear" width={14} height={14} />
        </button>
        <span className="git-pr__detail-titre">Nouvelle PR</span>
      </div>
      <div className="git-pr__detail-sous">
        {brancheCourante ? `De ${brancheCourante} vers la branche cible. La branche est poussée si besoin.` : "Aucune branche extraite : placez-vous sur une branche."}
      </div>
      <div className="git-pr__formulaire">
        <label className="git-panel__dialog-field">
          <span className="git-panel__dialog-label">Branche cible</span>
          <select className="git-panel__dialog-select" value={base} onChange={(e) => setBase(e.target.value)} data-champ="base">
            {bases.length === 0 && <option value="">(aucune autre branche)</option>}
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="git-panel__dialog-field">
          <span className="git-panel__dialog-label">Titre</span>
          <input
            type="text"
            className="git-panel__dialog-input"
            data-champ="titre"
            placeholder="Que change-t-elle ?"
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
          />
        </label>
        <label className="git-panel__dialog-field">
          <span className="git-panel__dialog-label">Description</span>
          <textarea
            className="git-panel__dialog-textarea"
            data-champ="description"
            rows={6}
            placeholder="Ce qui change, pourquoi, comment vérifier."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {note && <div className="git-pr__note">{note}</div>}
        {echec && <div className="git-panel__dialog-error" role="alert">{echec}</div>}
        <div className="git-pr__commit-barre">
          <button
            type="button"
            className="git-pr__bouton"
            data-action="rediger-pr"
            disabled={occupe !== null || memeBranche}
            onClick={() => void rediger()}
            title="Rédiger le titre et la description avec l'IA à partir du diff de la branche"
          >
            {occupe === "rediger" ? <span className="git-panel__spinner git-panel__spinner--inline" /> : <Icon icon="solar:magic-stick-3-linear" width={13} height={13} />}
            <span>{occupe === "rediger" ? "Rédaction…" : "Rédiger"}</span>
          </button>
          {brouillonPossible && (
            <label className="git-pr__case">
              <input type="checkbox" checked={brouillon} onChange={(e) => setBrouillon(e.target.checked)} />
              <span>Brouillon</span>
            </label>
          )}
          <button
            type="button"
            className="git-panel__action"
            data-action="creer-pr"
            disabled={occupe !== null || memeBranche || !titre.trim() || !base}
            onClick={() => void creer()}
          >
            {occupe === "creer" ? <span className="git-panel__spinner git-panel__spinner--inline" /> : null}
            <span>{brouillon ? "Créer le brouillon" : "Créer la PR"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

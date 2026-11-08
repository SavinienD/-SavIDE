// Revue des changements : conflits d'une fusion, d'un rebase, d'un cherry-pick ou d'un revert.
// Trois volets : notre version, la leur, le résultat (modifiable) ; par bloc « Prendre la
// nôtre / la leur / les deux » ; « Marquer résolu », « Continuer », « Abandonner » ;
// « Demander à l'agent » envoie les blocs en conflit dans la conversation choisie.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import { Icon } from "@iconify/react";
import { languageForPath } from "../../lib/language";
import { fournirActions } from "../../axe/raccourcis";
import { infoBulle } from "./infoBulle";
import { MonacoSimple, type ZoneLignes } from "./MonacoSimple";
import { blocDeLigne, blocsDeConflit, contenuChoisi, messageConflits, type ChoixConflit } from "./blocsConflit";
import { ChoixConversation, useConversationsDuDossier } from "./ChoixConversation";
import { envoyerDansConversation, notifier } from "./envoi";
import { langageFence } from "./PanneauNotes";
import { conflitsApi, texteErreur, type DetailConflit, type EtatConflits } from "./revueApi";
import { nomEtDossier } from "./ListeFichiers";

type Avis = { genre: "ok" | "erreur"; texte: string };

export function libelleCode(code: string): string {
  switch (code) {
    case "UU":
      return "Modifié des deux côtés";
    case "AA":
      return "Ajouté des deux côtés";
    case "DU":
      return "Supprimé chez nous, modifié chez eux";
    case "UD":
      return "Modifié chez nous, supprimé chez eux";
    case "AU":
      return "Ajouté chez nous";
    case "UA":
      return "Ajouté chez eux";
    case "DD":
      return "Supprimé des deux côtés";
    default:
      return code;
  }
}

export function titreOperation(e: Pick<EtatConflits, "operation" | "nous" | "eux">): string {
  switch (e.operation) {
    case "fusion":
      return `Fusion de « ${e.eux} » dans « ${e.nous} »`;
    case "rebase":
      return `Rebasage sur « ${e.nous} »`;
    case "cherry-pick":
      return `Report de « ${e.eux} »`;
    case "revert":
      return `Annulation de « ${e.eux} »`;
    default:
      return "Conflits";
  }
}

function dansSaisie(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export function VueConflits({ dossier, fichier, onFini }: { dossier: string; fichier?: string | null; onFini: (message: string | null) => void }) {
  const [etat, setEtat] = useState<EtatConflits | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [choix, setChoix] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailConflit | null>(null);
  const [resultat, setResultat] = useState("");
  const [blocCourant, setBlocCourant] = useState(0);
  const [occupe, setOccupe] = useState(false);
  const [avis, setAvis] = useState<Avis | null>(null);
  const [abandonArme, setAbandonArme] = useState(false);
  const editeurRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const conversation = useConversationsDuDossier(dossier);

  const charger = useCallback(async () => {
    try {
      const e = await conflitsApi.etat(dossier);
      setEtat(e);
      setErreur(null);
      setChoix((c) => {
        if (c && e.fichiers.some((f) => f.chemin === c)) return c;
        // Fichier en conflit cliqué dans la liste des changements : on l'ouvre d'abord.
        if (fichier && e.fichiers.some((f) => f.chemin === fichier)) return fichier;
        return e.fichiers[0]?.chemin ?? null;
      });
      return e;
    } catch (err) {
      setErreur(texteErreur(err));
      return null;
    }
  }, [dossier, fichier]);
  useEffect(() => {
    void charger();
  }, [charger]);

  useEffect(() => {
    if (!choix) {
      setDetail(null);
      return;
    }
    let vivant = true;
    conflitsApi
      .fichier(dossier, choix)
      .then((d) => {
        if (!vivant) return;
        setDetail(d);
        setResultat(d.resultat ?? "");
        setBlocCourant(0);
      })
      .catch((err) => vivant && setAvis({ genre: "erreur", texte: texteErreur(err) }));
    return () => {
      vivant = false;
    };
  }, [dossier, choix]);

  const blocs = useMemo(() => blocsDeConflit(resultat), [resultat]);
  const zones = useMemo<ZoneLignes[]>(
    () =>
      blocs.flatMap((b) => {
        const finNous = b.debut + b.nous.length;
        const z: ZoneLignes[] = [{ debut: b.debut, fin: b.debut, classe: "revue-conflit-marqueur" }];
        if (b.nous.length) z.push({ debut: b.debut + 1, fin: finNous, classe: "revue-conflit-nous" });
        if (b.eux.length) z.push({ debut: b.fin - b.eux.length, fin: b.fin - 1, classe: "revue-conflit-eux" });
        z.push({ debut: b.fin, fin: b.fin, classe: "revue-conflit-marqueur" });
        return z;
      }),
    [blocs],
  );
  const courant = blocs.length ? Math.min(blocCourant, blocs.length - 1) : -1;

  const allerBloc = useCallback(
    (i: number) => {
      if (!blocs.length) return;
      const j = (i + blocs.length) % blocs.length;
      setBlocCourant(j);
      const ed = editeurRef.current;
      if (ed) {
        ed.setPosition({ lineNumber: blocs[j].debut, column: 1 });
        ed.revealLineInCenterIfOutsideViewport(blocs[j].debut);
        ed.focus();
      }
    },
    [blocs],
  );

  /** Remplace le bloc courant par la version choisie (Ctrl+Z possible dans le résultat). */
  const prendre = useCallback(
    (quoi: ChoixConflit) => {
      const ed = editeurRef.current;
      const modele = ed?.getModel();
      const b = blocs[courant];
      if (!ed || !modele || !b) return;
      const lignes = contenuChoisi(b, quoi);
      const derniere = modele.getLineCount();
      let range = { startLineNumber: b.debut, startColumn: 1, endLineNumber: b.fin, endColumn: modele.getLineMaxColumn(b.fin) };
      if (!lignes.length) {
        range = b.fin < derniere
          ? { startLineNumber: b.debut, startColumn: 1, endLineNumber: b.fin + 1, endColumn: 1 }
          : b.debut > 1
            ? { startLineNumber: b.debut - 1, startColumn: modele.getLineMaxColumn(b.debut - 1), endLineNumber: b.fin, endColumn: modele.getLineMaxColumn(b.fin) }
            : range;
      }
      ed.pushUndoStop();
      ed.executeEdits("conflit", [{ range, text: lignes.join(modele.getEOL()) }]);
      ed.pushUndoStop();
      setResultat(ed.getValue());
    },
    [blocs, courant],
  );

  const resoudre = useCallback(
    async (options: { marquer: boolean; supprimer?: boolean; contenu?: string | null }) => {
      if (!choix || occupe) return;
      setOccupe(true);
      setAvis(null);
      try {
        const contenu = options.supprimer ? null : options.contenu === undefined ? resultat : options.contenu;
        const message = await conflitsApi.resoudre(dossier, choix, contenu, { marquer: options.marquer, supprimer: options.supprimer });
        setAvis({ genre: "ok", texte: message });
        if (options.marquer) await charger();
      } catch (err) {
        setAvis({ genre: "erreur", texte: texteErreur(err) });
      } finally {
        setOccupe(false);
      }
    },
    [charger, choix, dossier, occupe, resultat],
  );

  const terminer = useCallback(
    async (quoi: "continuer" | "abandonner") => {
      if (occupe) return;
      setOccupe(true);
      setAvis(null);
      setAbandonArme(false);
      try {
        const message = await conflitsApi.action(dossier, quoi);
        const e = await charger();
        if (e && !e.operation) onFini(message);
        else setAvis({ genre: "ok", texte: message });
      } catch (err) {
        setAvis({ genre: "erreur", texte: texteErreur(err) });
      } finally {
        setOccupe(false);
      }
    },
    [charger, dossier, occupe, onFini],
  );

  const demanderALAgent = useCallback(async () => {
    if (!etat || !conversation.cible || occupe) return;
    setOccupe(true);
    setAvis(null);
    try {
      const fichiers = await Promise.all(
        etat.fichiers.map(async (f) => {
          const d = f.chemin === choix ? { resultat } : await conflitsApi.fichier(dossier, f.chemin).catch(() => null);
          return { chemin: f.chemin, code: f.code, texte: d?.resultat ?? null };
        }),
      );
      await envoyerDansConversation(dossier, conversation.cible, messageConflits(titreOperation(etat), fichiers, etat.nous, etat.eux, langageFence));
      const texte = `Conflits envoyés dans « ${conversation.titre} »`;
      setAvis({ genre: "ok", texte });
      notifier("info", "Conflits envoyés à l'agent", texte, dossier, conversation.cible);
    } catch (err) {
      setAvis({ genre: "erreur", texte: `Envoi impossible : ${texteErreur(err)}` });
    } finally {
      setOccupe(false);
    }
  }, [choix, conversation.cible, conversation.titre, dossier, etat, occupe, resultat]);

  const fichierVoisin = useCallback(
    (sens: 1 | -1) => {
      const liste = etat?.fichiers ?? [];
      if (!liste.length) return;
      const i = liste.findIndex((f) => f.chemin === choix);
      setChoix(liste[(Math.max(0, i) + sens + liste.length) % liste.length].chemin);
    },
    [choix, etat],
  );

  // F7 / Maj+F7 : bloc de conflit suivant / précédent ; Alt+↓ / Alt+↑ : fichier en conflit.
  const actions = useRef({ allerBloc, fichierVoisin, courant });
  actions.current = { allerBloc, fichierVoisin, courant };
  useEffect(
    () =>
      fournirActions({
        revueBlocSuivant: (e) => (dansSaisie(e) ? false : actions.current.allerBloc(actions.current.courant + 1)),
        revueBlocPrecedent: (e) => (dansSaisie(e) ? false : actions.current.allerBloc(actions.current.courant - 1)),
        revueFichierSuivant: (e) => (dansSaisie(e) ? false : actions.current.fichierVoisin(1)),
        revueFichierPrecedent: (e) => (dansSaisie(e) ? false : actions.current.fichierVoisin(-1)),
      }),
    [],
  );

  if (erreur) return <p className="revue-avis" data-genre="erreur" role="alert">{erreur}</p>;
  if (!etat) return <p className="revue-diff__message">Lecture des conflits…</p>;

  const langage = choix ? languageForPath(choix) : "plaintext";
  const unCoteAbsent = detail && !detail.binaire && (detail.nous === null || detail.eux === null);
  const reste = etat.fichiers.length;
  const [nom, sousDossier] = choix ? nomEtDossier(choix) : ["", ""];

  return (
    <div className="revue-conflits">
      <div className="revue-conflits__tete">
        <span className="revue-conflits__titre" title={titreOperation(etat)}>{titreOperation(etat)}</span>
        <span className="revue-conflits__reste">
          {reste ? `${reste} fichier${reste > 1 ? "s" : ""} en conflit` : "Tous les conflits sont résolus"}
        </span>
        <span className="revue-espace" />
        <ChoixConversation etat={conversation} compact />
        <button type="button" className="revue-bouton" data-action="demander-agent" disabled={!reste || !conversation.cible || occupe} onClick={() => void demanderALAgent()}>
          <Icon icon="solar:chat-round-line-linear" width={14} height={14} />
          <span>Demander à l'agent</span>
        </button>
        <button
          type="button"
          className="revue-bouton"
          data-action="abandonner"
          data-arme={abandonArme ? "true" : "false"}
          disabled={occupe || !etat.operation}
          onBlur={() => setAbandonArme(false)}
          onClick={() => (abandonArme ? void terminer("abandonner") : setAbandonArme(true))}
          title={abandonArme ? "Cliquer encore : le dépôt revient à l'état d'avant" : "Abandonner l'opération"}
        >
          {abandonArme ? "Confirmer l'abandon" : "Abandonner"}
        </button>
        <button type="button" className="revue-bouton revue-bouton--principal" data-action="continuer" disabled={occupe || reste > 0 || !etat.operation} onClick={() => void terminer("continuer")} title={reste ? "Marquez d'abord chaque fichier résolu" : "Terminer l'opération"}>
          Continuer
        </button>
      </div>
      {avis ? (
        <p className="revue-avis" data-genre={avis.genre} role={avis.genre === "erreur" ? "alert" : "status"}>{avis.texte}</p>
      ) : null}
      <div className="revue-conflits__corps">
        <nav className="revue-colonne revue-colonne--fichiers" aria-label="Fichiers en conflit">
          {etat.fichiers.length ? (
            <div className="revue-fichiers">
              {etat.fichiers.map((f) => {
                const [n, d] = nomEtDossier(f.chemin);
                return (
                  <div key={f.chemin} className="revue-fichier" data-actif={f.chemin === choix ? "true" : "false"} data-fichier={f.chemin}>
                    <button type="button" className="revue-fichier__principal" onClick={() => setChoix(f.chemin)} title={`${f.chemin} · ${libelleCode(f.code)}`} aria-current={f.chemin === choix ? "true" : undefined}>
                      <span className="revue-fichier__statut" data-statut="U">{f.code}</span>
                      <span className="revue-fichier__nom">{n}</span>
                      {d ? <span className="revue-fichier__dossier">{d}</span> : null}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="revue-fichiers__vide">Aucun fichier en conflit</p>
          )}
        </nav>

        <section className="revue-conflits__fichier" aria-label="Résolution du fichier">
          {!choix || !detail ? (
            <p className="revue-diff__message">{reste ? "Chargement du fichier…" : "Plus rien à résoudre : cliquez sur « Continuer »."}</p>
          ) : detail.binaire ? (
            <p className="revue-diff__message">Fichier binaire : choisissez la version à garder dans un terminal, ou demandez à l'agent.</p>
          ) : unCoteAbsent ? (
            <div className="revue-conflits__absent">
              <p className="revue-diff__message">
                {detail.nous === null ? "Ce fichier a été supprimé de notre côté et modifié de l'autre." : "Ce fichier a été supprimé de l'autre côté et modifié du nôtre."}
              </p>
              <div className="revue-note__boutons">
                <button type="button" className="revue-bouton" disabled={occupe} onClick={() => void resoudre({ marquer: true, contenu: detail.nous ?? detail.eux })}>
                  Garder le fichier
                </button>
                <button type="button" className="revue-bouton" disabled={occupe} onClick={() => void resoudre({ marquer: true, supprimer: true })}>
                  Supprimer le fichier
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="revue-conflits__versions">
                <div className="revue-conflits__volet">
                  <h3 className="revue-conflits__etiquette">Notre version · {etat.nous}</h3>
                  <MonacoSimple valeur={detail.nous ?? ""} langage={langage} lectureSeule etiquette="Notre version" />
                </div>
                <div className="revue-conflits__volet">
                  <h3 className="revue-conflits__etiquette">La leur · {etat.eux}</h3>
                  <MonacoSimple valeur={detail.eux ?? ""} langage={langage} lectureSeule etiquette="La leur" />
                </div>
              </div>
              <div className="revue-diff__barre" data-blocs={blocs.length}>
                <button type="button" className="revue-icone" disabled={!blocs.length} onClick={() => allerBloc(courant - 1)} title={infoBulle("Conflit précédent", "revueBlocPrecedent")} aria-label="Conflit précédent">
                  <Icon icon="solar:alt-arrow-left-linear" width={15} height={15} />
                </button>
                <span className="revue-diff__bloc" aria-live="polite">{blocs.length ? `Conflit ${courant + 1} sur ${blocs.length}` : "Aucun marqueur"}</span>
                <button type="button" className="revue-icone" disabled={!blocs.length} onClick={() => allerBloc(courant + 1)} title={infoBulle("Conflit suivant", "revueBlocSuivant")} aria-label="Conflit suivant">
                  <Icon icon="solar:alt-arrow-right-linear" width={15} height={15} />
                </button>
                <span className="revue-espace" />
                <span className="revue-conflits__prendre" id="revue-prendre">Prendre</span>
                <button type="button" className="revue-bouton" data-action="prendre-nous" disabled={courant < 0} onClick={() => prendre("nous")} aria-label="Prendre la nôtre" title="Prendre notre version pour ce bloc">la nôtre</button>
                <button type="button" className="revue-bouton" data-action="prendre-eux" disabled={courant < 0} onClick={() => prendre("eux")} aria-label="Prendre la leur" title="Prendre leur version pour ce bloc">la leur</button>
                <button type="button" className="revue-bouton" data-action="prendre-deux" disabled={courant < 0} onClick={() => prendre("deux")} aria-label="Prendre les deux" title="Garder les deux versions, la nôtre d'abord">les deux</button>
              </div>
              <div className="revue-conflits__resultat">
                <h3 className="revue-conflits__etiquette" title={choix}>
                  Résultat modifiable · {nom}
                  {sousDossier ? <span className="revue-conflits__dossier">{sousDossier}</span> : null}
                </h3>
                <MonacoSimple
                  valeur={resultat}
                  langage={langage}
                  lectureSeule={false}
                  zones={zones}
                  etiquette="Résultat de la résolution"
                  onChange={setResultat}
                  onPret={(ed) => {
                    editeurRef.current = ed;
                  }}
                  onCurseur={(ligne) => {
                    const i = blocDeLigne(blocs, ligne);
                    if (i >= 0) setBlocCourant(i);
                  }}
                />
              </div>
              <div className="revue-conflits__pied">
                <span className="revue-conflits__aide">{blocs.length ? "Choisissez une version pour chaque bloc, ou modifiez le résultat." : "Plus aucun marqueur dans ce fichier."}</span>
                <span className="revue-espace" />
                <button type="button" className="revue-bouton" disabled={occupe} onClick={() => void resoudre({ marquer: false })}>Enregistrer</button>
                <button type="button" className="revue-bouton revue-bouton--principal" data-action="marquer-resolu" disabled={occupe || blocs.length > 0} onClick={() => void resoudre({ marquer: true })} title={blocs.length ? "Il reste des blocs en conflit" : "Écrire le résultat et le marquer résolu"}>
                  Marquer résolu
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// Revue des changements : vue « Changements » du dossier : fichiers modifiés (HEAD ou branche
// de base), diff Monaco côte à côte ou en ligne, indexation par bloc ou par lignes,
// notes de relecture envoyées en UN message à l'agent.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Icon } from "@iconify/react";
import { languageForPath } from "../../lib/language";
import { fournirActions } from "../../axe/raccourcis";
import { infoBulle } from "./infoBulle";
import { DiffMonaco, type DiffApi, type MarqueNote, type SelectionDiff } from "./DiffMonaco";
import { ListeFichiers, nomEtDossier, titreGroupe } from "./ListeFichiers";
import { PanneauNotes, type BrouillonNote } from "./PanneauNotes";
import { VueConflits } from "./VueConflits";
import { magasinNotes, type NoteRevue } from "./notes";
import {
  blocALaLigne,
  blocVoisin,
  compteurs,
  ligneDuBloc,
  lignesDeSelection,
  lignesDuBloc,
  type Bloc,
  type Cote,
} from "./selectionDiff";
import {
  estFichierChange,
  revueApi,
  texteErreur,
  type ActionRevue,
  type DiffRevue,
  type FichierRevue,
  type GroupeRevue,
  type ListeRevue,
} from "./revueApi";

export type OngletRevue = "changements" | "conflits";

type Props = {
  dossier: string;
  fichier?: string | null;
  onFermer: () => void;
  ongletInitial?: OngletRevue;
};

type Choix = { chemin: string; groupe: GroupeRevue };
type Avis = { genre: "ok" | "erreur"; texte: string };

const CLE_EN_LIGNE = "revue:en-ligne";
const CLE_NOTES = "revue:notes-visibles";

function lire(cle: string, defaut: boolean): boolean {
  try {
    const v = localStorage.getItem(cle);
    return v === null ? defaut : v === "1";
  } catch {
    return defaut;
  }
}
function ecrire(cle: string, v: boolean): void {
  try {
    localStorage.setItem(cle, v ? "1" : "0");
  } catch {
    // stockage indisponible : réglage valable pour cette session
  }
}

/** La touche vient d'un champ de saisie : elle n'est pas pour la vue. */
function dansSaisie(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

export function VueRevue({ dossier, fichier, onFermer, ongletInitial }: Props) {
  const magasin = magasinNotes();
  const notes = useSyncExternalStore(magasin.abonner, () => magasin.notes(dossier));
  const [onglet, setOnglet] = useState<OngletRevue>(ongletInitial ?? "changements");
  const [base, setBase] = useState("HEAD");
  const [liste, setListe] = useState<ListeRevue | null>(null);
  const [erreurListe, setErreurListe] = useState<string | null>(null);
  const [choix, setChoix] = useState<Choix | null>(null);
  const [diff, setDiff] = useState<DiffRevue | null>(null);
  const [erreurDiff, setErreurDiff] = useState<string | null>(null);
  const [rechargement, setRechargement] = useState(0);
  const [enLigne, setEnLigne] = useState(() => lire(CLE_EN_LIGNE, false));
  const [notesVisibles, setNotesVisibles] = useState(() => lire(CLE_NOTES, true));
  const [blocs, setBlocs] = useState<Bloc[]>([]);
  const [blocCourant, setBlocCourant] = useState(-1);
  const [selection, setSelection] = useState<SelectionDiff | null>(null);
  const [brouillon, setBrouillon] = useState<BrouillonNote | null>(null);
  const [avis, setAvis] = useState<Avis | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [annulerArme, setAnnulerArme] = useState(false);
  const [conflitChoisi, setConflitChoisi] = useState<string | null>(null);
  const apiRef = useRef<DiffApi | null>(null);
  const vueRef = useRef<HTMLDivElement | null>(null);
  const allerApres = useRef<{ cote: Cote; ligne: number } | null>(null);
  const premierChargement = useRef(true);
  const baseArg = base === "HEAD" ? null : base;

  const chargerListe = useCallback(async () => {
    try {
      const l = await revueApi.liste(dossier, baseArg);
      setListe(l);
      setErreurListe(null);
      // Fusion ou rebase arrêté sur des conflits : on arrive sur les conflits.
      if (premierChargement.current && !ongletInitial && l.conflits > 0) setOnglet("conflits");
      premierChargement.current = false;
      setChoix((c) => {
        if (c && l.fichiers.some((f) => f.chemin === c.chemin && f.groupe === c.groupe)) return c;
        const memeFichier = c && l.fichiers.find((f) => f.chemin === c.chemin && f.groupe !== "conflit");
        const voulu = fichier ? l.fichiers.find((f) => f.chemin === fichier && f.groupe !== "conflit") : undefined;
        const premier = memeFichier ?? voulu ?? l.fichiers.find((f) => f.groupe !== "conflit");
        return premier ? { chemin: premier.chemin, groupe: premier.groupe } : null;
      });
    } catch (err) {
      setListe(null);
      setErreurListe(texteErreur(err));
    }
  }, [dossier, baseArg, fichier, ongletInitial]);

  useEffect(() => {
    void chargerListe();
  }, [chargerListe]);

  // Le clavier va à la vue dès l'ouverture (raccourcis, Échap), pas à la saisie du chat restée dessous.
  useEffect(() => {
    vueRef.current?.focus();
  }, []);

  const actualiser = useCallback(() => {
    void chargerListe();
    setRechargement((n) => n + 1);
  }, [chargerListe]);

  // Retour dans la fenêtre (l'agent ou un terminal a pu changer des fichiers).
  useEffect(() => {
    const surFocus = () => actualiser();
    window.addEventListener("focus", surFocus);
    return () => window.removeEventListener("focus", surFocus);
  }, [actualiser]);

  useEffect(() => {
    if (!choix || choix.groupe === "conflit") {
      setDiff(null);
      return;
    }
    let vivant = true;
    setErreurDiff(null);
    revueApi
      .diff(dossier, choix.chemin, choix.groupe, baseArg)
      .then((d) => {
        if (!vivant) return;
        setDiff((avant) => (avant && avant.empreinte === d.empreinte && avant.chemin === d.chemin && avant.groupe === d.groupe ? avant : d));
      })
      .catch((err) => {
        if (!vivant) return;
        setDiff(null);
        setErreurDiff(texteErreur(err));
      });
    return () => {
      vivant = false;
    };
  }, [dossier, choix, baseArg, rechargement]);

  useEffect(() => {
    setBlocs([]);
    setBlocCourant(-1);
    setSelection(null);
    setAnnulerArme(false);
  }, [diff]);

  const fichiersOrdonnes = useMemo<FichierRevue[]>(() => {
    if (!liste) return [];
    const ordre: GroupeRevue[] = ["non-indexe", "indexe", "base"];
    return ordre.flatMap((g) => liste.fichiers.filter((f) => f.groupe === g));
  }, [liste]);

  const notesParFichier = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) m.set(n.fichier, (m.get(n.fichier) ?? 0) + 1);
    return m;
  }, [notes]);

  const marques = useMemo<MarqueNote[]>(
    () =>
      notes
        .filter((n) => choix && n.fichier === choix.chemin && n.cote !== "apercu" && n.debut !== null)
        .map((n) => ({ cote: n.cote as Cote, debut: n.debut as number, fin: (n.fin ?? n.debut) as number })),
    [notes, choix],
  );

  const choisirFichier = useCallback((f: FichierRevue) => {
    if (f.groupe === "conflit") {
      setConflitChoisi(f.chemin);
      setOnglet("conflits");
      return;
    }
    setChoix({ chemin: f.chemin, groupe: f.groupe });
    setAvis(null);
  }, []);

  const fichierVoisin = useCallback(
    (sens: 1 | -1) => {
      if (!fichiersOrdonnes.length) return;
      const i = choix ? fichiersOrdonnes.findIndex((f) => f.chemin === choix.chemin && f.groupe === choix.groupe) : -1;
      const j = i < 0 ? 0 : (i + sens + fichiersOrdonnes.length) % fichiersOrdonnes.length;
      choisirFichier(fichiersOrdonnes[j]);
    },
    [choix, choisirFichier, fichiersOrdonnes],
  );

  /** Côté où lire le curseur : « nouveau » quand le diff est en ligne. */
  const coteCourant = useCallback((): Cote => {
    const s = apiRef.current?.selection();
    if (!s || enLigne || !apiRef.current?.deuxCotes()) return "nouveau";
    return s.cote;
  }, [enLigne]);

  const allerBloc = useCallback(
    (sens: 1 | -1) => {
      const api = apiRef.current;
      if (!api || !blocs.length) return;
      const cote = coteCourant();
      const s = api.selection();
      const ligne = s.cote === cote ? s.ligne : 0;
      const i = blocVoisin(blocs, cote, ligne, sens);
      if (i < 0) return;
      setBlocCourant(i);
      api.allerA(cote, ligneDuBloc(blocs[i], cote));
    },
    [blocs, coteCourant],
  );

  const surBlocs = useCallback((b: Bloc[]) => {
    setBlocs(b);
    const cible = allerApres.current;
    if (cible && apiRef.current) {
      allerApres.current = null;
      apiRef.current.allerA(cible.cote, cible.ligne);
    }
    setBlocCourant((c) => (c >= b.length ? b.length - 1 : c < 0 && b.length ? 0 : c));
  }, []);

  const surSelection = useCallback(
    (s: SelectionDiff) => {
      setSelection(s);
      const i = blocALaLigne(blocs, s.cote, s.ligne);
      if (i >= 0) setBlocCourant(i);
    },
    [blocs],
  );

  /** Lignes visées : la sélection si elle couvre des lignes, sinon le bloc courant. */
  const lignesVisees = useCallback(() => {
    const s = apiRef.current?.selection();
    if (s && !s.vide) return lignesDeSelection(blocs, s.cote, s.debut, s.fin);
    const i = s ? blocALaLigne(blocs, s.cote, s.ligne) : -1;
    const b = blocs[i >= 0 ? i : blocCourant];
    return b ? lignesDuBloc(b) : null;
  }, [blocs, blocCourant]);

  const agir = useCallback(
    async (action: ActionRevue, entier: FichierRevue | null = null) => {
      if (occupe) return;
      const cible = entier ?? (choix && diff ? { chemin: choix.chemin, groupe: choix.groupe } : null);
      if (!cible) return;
      let lignes = null;
      if (!entier) {
        lignes = lignesVisees();
        if (!lignes || (!lignes.anciennes.length && !lignes.nouvelles.length)) {
          setAvis({ genre: "erreur", texte: "Placez le curseur dans un bloc modifié ou choisissez des lignes." });
          return;
        }
      }
      setOccupe(true);
      setAvis(null);
      try {
        const message = await revueApi.appliquer(dossier, cible.chemin, cible.groupe, action, lignes, entier ? null : diff?.empreinte ?? null);
        setAvis({ genre: "ok", texte: message });
      } catch (err) {
        // Fichier changé entre-temps : la vue est relue juste après (finally).
        setAvis({ genre: "erreur", texte: estFichierChange(err) ? texteErreur(err) : `Échec : ${texteErreur(err)}` });
      } finally {
        setOccupe(false);
        setAnnulerArme(false);
        actualiser();
      }
    },
    [actualiser, choix, diff, dossier, lignesVisees, occupe],
  );

  const noter = useCallback(() => {
    const api = apiRef.current;
    if (!api || !choix || !diff) return;
    const s = api.selection();
    let cote: Cote = s.cote;
    let debut = s.debut;
    let fin = s.fin;
    if (s.vide) {
      const i = blocALaLigne(blocs, s.cote, s.ligne);
      const b = blocs[i >= 0 ? i : blocCourant];
      if (b && b.modifiedEndLineNumber > 0) [cote, debut, fin] = ["nouveau", b.modifiedStartLineNumber, b.modifiedEndLineNumber];
      else if (b && b.originalEndLineNumber > 0) [cote, debut, fin] = ["ancien", b.originalStartLineNumber, b.originalEndLineNumber];
      else [debut, fin] = [s.ligne, s.ligne];
    }
    setBrouillon({ fichier: choix.chemin, cote, debut, fin, extrait: api.texte(cote, debut, fin) });
    setNotesVisibles(true);
    ecrire(CLE_NOTES, true);
  }, [blocs, blocCourant, choix, diff]);

  const allerANote = useCallback(
    (n: NoteRevue) => {
      if (n.cote === "apercu" || n.debut === null) return;
      const cible = { cote: n.cote as Cote, ligne: n.debut };
      if (choix?.chemin === n.fichier && apiRef.current) {
        apiRef.current.allerA(cible.cote, cible.ligne);
        return;
      }
      const f = liste?.fichiers.find((x) => x.chemin === n.fichier && x.groupe === choix?.groupe) ?? liste?.fichiers.find((x) => x.chemin === n.fichier && x.groupe !== "conflit");
      if (!f) return;
      allerApres.current = cible;
      choisirFichier(f);
    },
    [choix, choisirFichier, liste],
  );

  // Raccourcis de la vue (registre src/axe/raccourcis.ts) : la vue ouverte passe devant.
  const actions = useRef({ allerBloc, fichierVoisin, noter, onFermer, brouillon });
  actions.current = { allerBloc, fichierVoisin, noter, onFermer, brouillon };
  useEffect(
    () =>
      fournirActions({
        stop: () => {
          // Échap ferme d'abord la recherche ou les suggestions de Monaco.
          if (document.querySelector(".revue-vue :is(.find-widget.visible, .suggest-widget.visible)")) return false;
          if (actions.current.brouillon) setBrouillon(null);
          else actions.current.onFermer();
        },
        revueChangements: () => actions.current.onFermer(),
        revueBlocSuivant: (e) => (dansSaisie(e) ? false : actions.current.allerBloc(1)),
        revueBlocPrecedent: (e) => (dansSaisie(e) ? false : actions.current.allerBloc(-1)),
        revueFichierSuivant: (e) => (dansSaisie(e) ? false : actions.current.fichierVoisin(1)),
        revueFichierPrecedent: (e) => (dansSaisie(e) ? false : actions.current.fichierVoisin(-1)),
        revueNoter: (e) => (dansSaisie(e) ? false : actions.current.noter()),
      }),
    [],
  );

  const nbConflits = liste?.conflits ?? 0;
  const enConflit = Boolean(liste?.operation) || nbConflits > 0;
  // L'opération finie (continuer, abandonner), l'onglet des conflits disparaît.
  const ongletVu: OngletRevue = enConflit ? onglet : "changements";
  const groupe = choix?.groupe ?? null;
  const fichierChoisi = choix ? liste?.fichiers.find((f) => f.chemin === choix.chemin && f.groupe === choix.groupe) ?? null : null;
  const [nom, sousDossier] = choix ? nomEtDossier(choix.chemin) : ["", ""];
  const total = compteurs(blocs);
  const surSelectionLignes = Boolean(selection && !selection.vide);
  const cible = surSelectionLignes ? "la sélection" : "le bloc";
  const peutAgir = Boolean(diff && !diff.binaire && !diff.tropGros && blocs.length && !occupe);

  return (
    <div className="revue-voile">
      <div className="revue-vue" ref={vueRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Changements du dossier">
        <header className="revue-tete">
          <h2 className="revue-tete__titre">Changements</h2>
          {enConflit ? (
            <div className="revue-onglets" role="tablist">
              <button type="button" role="tab" aria-selected={ongletVu === "changements"} data-actif={ongletVu === "changements" ? "true" : "false"} onClick={() => setOnglet("changements")}>
                Fichiers
              </button>
              <button type="button" role="tab" aria-selected={ongletVu === "conflits"} data-actif={ongletVu === "conflits" ? "true" : "false"} onClick={() => setOnglet("conflits")}>
                Conflits
                {nbConflits ? <span className="revue-onglets__nombre">{nbConflits}</span> : null}
              </button>
            </div>
          ) : null}
          <span className="revue-espace" />
          {ongletVu === "changements" ? (
            <label className="revue-champ revue-champ--base">
              <span>Comparer à</span>
              <select value={base} onChange={(e) => setBase(e.target.value)} aria-label="Comparer à">
                <option value="HEAD">Dernière validation</option>
                {(liste?.branches ?? []).filter((b) => b !== liste?.branche).map((b) => (
                  <option key={b} value={b}>
                    {b}
                    {b === liste?.branchePrincipale ? " (principale)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            className="revue-bouton revue-tete__notes"
            data-actif={notesVisibles ? "true" : "false"}
            aria-pressed={notesVisibles}
            onClick={() => {
              setNotesVisibles((v) => {
                ecrire(CLE_NOTES, !v);
                return !v;
              });
            }}
            title={notesVisibles ? "Masquer les notes" : "Afficher les notes"}
          >
            <Icon icon="solar:notes-linear" width={14} height={14} />
            <span>Notes</span>
            {notes.length ? <span className="revue-onglets__nombre">{notes.length}</span> : null}
          </button>
          <button type="button" className="revue-icone" onClick={actualiser} title="Actualiser" aria-label="Actualiser">
            <Icon icon="solar:refresh-linear" width={15} height={15} />
          </button>
          <button type="button" className="revue-icone" onClick={onFermer} title={infoBulle("Fermer", "revueChangements")} aria-label="Fermer">
            <Icon icon="solar:close-circle-linear" width={16} height={16} />
          </button>
        </header>

        <div className="revue-corps" data-notes={notesVisibles ? "true" : "false"}>
          {ongletVu === "conflits" ? (
            <div className="revue-corps__conflits">
              <VueConflits
                dossier={dossier}
                fichier={conflitChoisi}
                onFini={(message) => {
                  setOnglet("changements");
                  if (message) setAvis({ genre: "ok", texte: message });
                  actualiser();
                }}
              />
            </div>
          ) : (
            <>
              <nav className="revue-colonne revue-colonne--fichiers" aria-label="Fichiers modifiés">
                {erreurListe ? (
                  <p className="revue-avis" data-genre="erreur" role="alert">{erreurListe}</p>
                ) : liste ? (
                  <ListeFichiers fichiers={liste.fichiers} base={liste.base} choix={choix} notesParFichier={notesParFichier} occupe={occupe} onChoisir={choisirFichier} onAction={(f, a) => void agir(a, f)} />
                ) : (
                  <p className="revue-fichiers__vide">Lecture du dépôt…</p>
                )}
              </nav>

              <section className="revue-diff" aria-label="Diff du fichier">
                {choix ? (
                  <>
                    <div className="revue-diff__tete">
                      <span className="revue-diff__chemin" title={choix.chemin}>
                        <span className="revue-diff__nom">{nom}</span>
                        {sousDossier ? <span className="revue-diff__dossier">{sousDossier}</span> : null}
                      </span>
                      {groupe ? <span className="revue-diff__groupe">{titreGroupe(groupe, liste?.base ?? "HEAD")}</span> : null}
                      {blocs.length ? (
                        <span className="revue-diff__compte">
                          <span className="revue-plus">+{total.ajouts}</span>
                          <span className="revue-moins">−{total.suppressions}</span>
                        </span>
                      ) : fichierChoisi && !fichierChoisi.binaire ? (
                        <span className="revue-diff__compte">
                          <span className="revue-plus">+{fichierChoisi.ajouts ?? 0}</span>
                          <span className="revue-moins">−{fichierChoisi.suppressions ?? 0}</span>
                        </span>
                      ) : null}
                      <span className="revue-espace" />
                      <button type="button" className="revue-icone" onClick={() => fichierVoisin(-1)} title={infoBulle("Fichier précédent", "revueFichierPrecedent")} aria-label="Fichier précédent">
                        <Icon icon="solar:alt-arrow-up-linear" width={15} height={15} />
                      </button>
                      <button type="button" className="revue-icone" onClick={() => fichierVoisin(1)} title={infoBulle("Fichier suivant", "revueFichierSuivant")} aria-label="Fichier suivant">
                        <Icon icon="solar:alt-arrow-down-linear" width={15} height={15} />
                      </button>
                      <div className="revue-segments" role="group" aria-label="Affichage du diff">
                        <button type="button" aria-pressed={!enLigne} data-actif={!enLigne ? "true" : "false"} onClick={() => { setEnLigne(false); ecrire(CLE_EN_LIGNE, false); }}>
                          Côte à côte
                        </button>
                        <button type="button" aria-pressed={enLigne} data-actif={enLigne ? "true" : "false"} onClick={() => { setEnLigne(true); ecrire(CLE_EN_LIGNE, true); }}>
                          En ligne
                        </button>
                      </div>
                    </div>

                    <div className="revue-diff__barre">
                      <button type="button" className="revue-icone" disabled={!blocs.length} onClick={() => allerBloc(-1)} title={infoBulle("Bloc précédent", "revueBlocPrecedent")} aria-label="Bloc précédent">
                        <Icon icon="solar:alt-arrow-left-linear" width={15} height={15} />
                      </button>
                      <span className="revue-diff__bloc" aria-live="polite">
                        {blocs.length ? `Bloc ${Math.max(1, blocCourant + 1)} sur ${blocs.length}` : diff ? "Aucun bloc" : ""}
                      </span>
                      <button type="button" className="revue-icone" disabled={!blocs.length} onClick={() => allerBloc(1)} title={infoBulle("Bloc suivant", "revueBlocSuivant")} aria-label="Bloc suivant">
                        <Icon icon="solar:alt-arrow-right-linear" width={15} height={15} />
                      </button>
                      <span className="revue-espace" />
                      {groupe === "non-indexe" ? (
                        <button type="button" className="revue-bouton" disabled={!peutAgir} onClick={() => void agir("indexer")} title={`Indexer ${cible}`}>
                          <Icon icon="solar:add-square-linear" width={14} height={14} />
                          <span>{surSelectionLignes ? "Indexer la sélection" : "Indexer le bloc"}</span>
                        </button>
                      ) : null}
                      {groupe === "indexe" ? (
                        <button type="button" className="revue-bouton" disabled={!peutAgir} onClick={() => void agir("desindexer")} title={`Retirer ${cible} de l'index`}>
                          <Icon icon="solar:minus-square-linear" width={14} height={14} />
                          <span>{surSelectionLignes ? "Désindexer la sélection" : "Désindexer le bloc"}</span>
                        </button>
                      ) : null}
                      {groupe === "non-indexe" && diff && !diff.nonSuivi && diff.nouveau !== null ? (
                        <button
                          type="button"
                          className="revue-bouton"
                          data-arme={annulerArme ? "true" : "false"}
                          disabled={!peutAgir}
                          onBlur={() => setAnnulerArme(false)}
                          onClick={() => {
                            if (!annulerArme) return setAnnulerArme(true);
                            void agir("annuler");
                          }}
                          title={annulerArme ? "Cliquer encore : les lignes reviennent à la version indexée" : `Annuler ${cible} dans le fichier`}
                        >
                          <Icon icon="solar:undo-left-linear" width={14} height={14} />
                          <span>{annulerArme ? "Confirmer l'annulation" : "Annuler"}</span>
                        </button>
                      ) : null}
                      <button type="button" className="revue-bouton" disabled={!diff || diff.binaire || diff.tropGros} onClick={noter} title={infoBulle("Noter les lignes choisies", "revueNoter")}>
                        <Icon icon="solar:pen-linear" width={14} height={14} />
                        <span>Noter</span>
                      </button>
                    </div>
                    {avis ? (
                      <p className="revue-avis revue-diff__avis" data-genre={avis.genre} role={avis.genre === "erreur" ? "alert" : "status"}>
                        {avis.texte}
                      </p>
                    ) : null}
                    <div className="revue-diff__zone">
                      {erreurDiff ? (
                        <p className="revue-avis" data-genre="erreur" role="alert">{erreurDiff}</p>
                      ) : !diff ? (
                        <p className="revue-diff__message">Chargement du diff…</p>
                      ) : diff.binaire ? (
                        <p className="revue-diff__message">Fichier binaire : pas de diff ligne à ligne. Les actions sur le fichier entier restent dans la liste.</p>
                      ) : diff.tropGros ? (
                        <p className="revue-diff__message">Fichier trop gros pour le diff. Les actions sur le fichier entier restent dans la liste.</p>
                      ) : (
                        <DiffMonaco
                          ancien={diff.ancien ?? ""}
                          nouveau={diff.nouveau ?? ""}
                          langage={languageForPath(diff.chemin)}
                          enLigne={enLigne}
                          marques={marques}
                          onPret={(api) => {
                            apiRef.current = api;
                          }}
                          onBlocs={surBlocs}
                          onSelection={surSelection}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <p className="revue-diff__message">{liste && !liste.fichiers.length ? "Rien n'a changé par rapport à cette base." : ""}</p>
                )}
              </section>

              {notesVisibles ? (
                <PanneauNotes dossier={dossier} notes={notes} brouillon={brouillon} onFinBrouillon={() => { setBrouillon(null); apiRef.current?.focus(); }} onAllerA={allerANote} />
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Revue des changements : notes du dossier (écrire, modifier, supprimer) et envoi en UN
// message dans une conversation du dossier (par défaut la plus récente).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "@iconify/react";
import { languageForPath } from "../../lib/language";
import { magasinNotes, messageNotes, reperNote, type CoteNote, type NoteRevue } from "./notes";
import { envoyerDansConversation, notifier } from "./envoi";
import { ChoixConversation, useConversationsDuDossier } from "./ChoixConversation";
import { texteErreur } from "./revueApi";

export type BrouillonNote = { fichier: string; cote: CoteNote; debut: number | null; fin: number | null; extrait: string };

export function langageFence(fichier: string): string {
  const l = languageForPath(fichier);
  return l && l !== "plaintext" ? l : "";
}

type Props = {
  dossier: string;
  notes: NoteRevue[];
  brouillon: BrouillonNote | null;
  onFinBrouillon: () => void;
  onAllerA?: (note: NoteRevue) => void;
  onEnvoye?: (conversationId: string) => void;
};

export function PanneauNotes({ dossier, notes, brouillon, onFinBrouillon, onAllerA, onEnvoye }: Props) {
  const magasin = magasinNotes();
  const [texte, setTexte] = useState("");
  const [edition, setEdition] = useState<{ id: string; texte: string } | null>(null);
  const choixConversation = useConversationsDuDossier(dossier);
  const { cible, titre } = choixConversation;
  const [envoi, setEnvoi] = useState(false);
  const [avis, setAvis] = useState<{ genre: "ok" | "erreur"; texte: string } | null>(null);
  const [effacerArme, setEffacerArme] = useState(false);
  const saisieRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!brouillon) return;
    setTexte("");
    window.requestAnimationFrame(() => saisieRef.current?.focus());
  }, [brouillon]);

  const ajouter = () => {
    if (!brouillon || !texte.trim()) return;
    magasin.ajouter(dossier, { ...brouillon, texte });
    setTexte("");
    setAvis(null);
    onFinBrouillon();
  };

  const toucheSaisie = (e: KeyboardEvent<HTMLTextAreaElement>, valider: () => void, annuler: () => void) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      valider();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      annuler();
    }
  };

  const envoyer = async () => {
    if (!notes.length || !cible || envoi) return;
    setEnvoi(true);
    setAvis(null);
    const ids = notes.map((n) => n.id);
    try {
      await envoyerDansConversation(dossier, cible, messageNotes(notes, langageFence));
      magasin.effacer(dossier, ids);
      const n = ids.length;
      const message = `${n} note${n > 1 ? "s" : ""} envoyée${n > 1 ? "s" : ""} dans « ${titre} »`;
      setAvis({ genre: "ok", texte: message });
      notifier("info", "Notes envoyées à l'agent", message, dossier, cible);
      onEnvoye?.(cible);
    } catch (err) {
      setAvis({ genre: "erreur", texte: `Envoi impossible : ${texteErreur(err)}` });
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <aside className="revue-notes" aria-label="Notes de relecture">
      <div className="revue-notes__tete">
        <h3>Notes</h3>
        <span className="revue-notes__nombre">{notes.length}</span>
        {notes.length > 0 ? (
          <button
            type="button"
            className="revue-lien"
            data-arme={effacerArme ? "true" : "false"}
            onBlur={() => setEffacerArme(false)}
            onClick={() => {
              if (!effacerArme) return setEffacerArme(true);
              setEffacerArme(false);
              magasin.effacer(dossier);
            }}
          >
            {effacerArme ? "Confirmer" : "Tout effacer"}
          </button>
        ) : null}
      </div>

      {brouillon ? (
        <div className="revue-note revue-note--brouillon">
          <div className="revue-note__repere">{reperNote({ ...brouillon, id: "", texte: "", creeLe: 0 })}</div>
          {brouillon.extrait ? <pre className="revue-note__extrait">{brouillon.extrait}</pre> : null}
          <textarea
            ref={saisieRef}
            className="revue-note__saisie"
            rows={3}
            value={texte}
            placeholder="Ce que l'agent doit changer"
            aria-label="Texte de la note"
            onChange={(e) => setTexte(e.target.value)}
            onKeyDown={(e) => toucheSaisie(e, ajouter, onFinBrouillon)}
          />
          <div className="revue-note__boutons">
            <button type="button" className="revue-bouton revue-bouton--principal" disabled={!texte.trim()} onClick={ajouter} title="Ajouter la note · Ctrl+Entrée">
              Ajouter
            </button>
            <button type="button" className="revue-bouton" onClick={onFinBrouillon}>
              Annuler
            </button>
          </div>
        </div>
      ) : null}

      <ol className="revue-notes__liste">
        {notes.map((n) => (
          <li key={n.id} className="revue-note" data-note={n.id}>
            <button type="button" className="revue-note__repere revue-note__repere--lien" onClick={() => onAllerA?.(n)} title="Afficher ces lignes">
              {reperNote(n)}
            </button>
            {edition?.id === n.id ? (
              <>
                <textarea
                  className="revue-note__saisie"
                  rows={3}
                  autoFocus
                  value={edition.texte}
                  aria-label="Modifier la note"
                  onChange={(e) => setEdition({ id: n.id, texte: e.target.value })}
                  onKeyDown={(e) =>
                    toucheSaisie(
                      e,
                      () => {
                        if (edition.texte.trim()) magasin.modifier(dossier, n.id, edition.texte);
                        setEdition(null);
                      },
                      () => setEdition(null),
                    )
                  }
                />
                <div className="revue-note__boutons">
                  <button
                    type="button"
                    className="revue-bouton revue-bouton--principal"
                    disabled={!edition.texte.trim()}
                    onClick={() => {
                      magasin.modifier(dossier, n.id, edition.texte);
                      setEdition(null);
                    }}
                  >
                    Enregistrer
                  </button>
                  <button type="button" className="revue-bouton" onClick={() => setEdition(null)}>
                    Annuler
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="revue-note__texte">{n.texte}</p>
                <div className="revue-note__outils">
                  <button type="button" className="revue-icone" onClick={() => setEdition({ id: n.id, texte: n.texte })} title="Modifier la note" aria-label="Modifier la note">
                    <Icon icon="solar:pen-linear" width={13} height={13} />
                  </button>
                  <button type="button" className="revue-icone" onClick={() => magasin.supprimer(dossier, n.id)} title="Supprimer la note" aria-label="Supprimer la note">
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>
      {!notes.length && !brouillon ? (
        <p className="revue-notes__aide">Choisissez des lignes dans le diff ou du texte dans l'aperçu Markdown, puis « Noter ».</p>
      ) : null}

      <div className="revue-notes__envoi">
        <ChoixConversation etat={choixConversation} />
        <button
          type="button"
          className="revue-bouton revue-bouton--principal revue-notes__envoyer"
          disabled={!notes.length || !cible || envoi}
          onClick={() => void envoyer()}
        >
          <Icon icon="solar:plain-linear" width={14} height={14} />
          <span>{envoi ? "Envoi…" : notes.length > 1 ? `Envoyer les ${notes.length} notes à l'agent` : "Envoyer à l'agent"}</span>
        </button>
        {avis ? (
          <p className="revue-avis" data-genre={avis.genre} role={avis.genre === "erreur" ? "alert" : "status"}>
            {avis.texte}
          </p>
        ) : null}
      </div>
    </aside>
  );
}

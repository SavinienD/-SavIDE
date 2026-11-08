// Commandes et prompts enregistrés : Réglages > Commandes, menu de la barre des terminaux
// et bouton du compositeur du chat.
import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { ouvrirReglages } from "../chat/SlashCommands";
import { MenuFlottant } from "./MenuFlottant";
import {
  CLE_COMMANDES,
  EVENEMENT_COMMANDES,
  ecrireCommandes,
  fichierActif,
  libelleCommande,
  lireCommandes,
  nouvelleCommande,
  remplacerVariables,
  variablesManquantes,
  type CommandeEnregistree,
  type GenreCommande,
  type Variables,
} from "./commandesEnregistrees";
import "./agents-cli.css";

/** Liste enregistrée, relue quand elle change (cette fenêtre ou une autre). */
export function useCommandesEnregistrees(): CommandeEnregistree[] {
  const [liste, setListe] = useState<CommandeEnregistree[]>(() => lireCommandes());
  useEffect(() => {
    const relire = () => setListe(lireCommandes());
    const stockage = (e: StorageEvent) => {
      if (e.key === CLE_COMMANDES) relire();
    };
    window.addEventListener(EVENEMENT_COMMANDES, relire);
    window.addEventListener("storage", stockage);
    return () => {
      window.removeEventListener(EVENEMENT_COMMANDES, relire);
      window.removeEventListener("storage", stockage);
    };
  }, []);
  return liste;
}

const GROUPES: [GenreCommande, string][] = [
  ["commande", "Commandes"],
  ["prompt", "Prompts"],
];

/** Contenu du menu : entrées par genre, puis « Gérer les commandes… ». */
function ListeCommandes({ variables, onChoisir, onFermer }: { variables: Variables; onChoisir: (texte: string, genre: GenreCommande) => void; onFermer: () => void }) {
  const liste = useCommandesEnregistrees();
  const [note, setNote] = useState("");
  return (
    <>
      {liste.length === 0 ? <p className="acli-menu__note">Aucune commande enregistrée.</p> : null}
      {GROUPES.map(([genre, titre]) => {
        const entrees = liste.filter((c) => c.genre === genre);
        if (!entrees.length) return null;
        return (
          <Fragment key={genre}>
            <p className="acli-menu__titre">{titre}</p>
            {entrees.map((c) => {
              const manque = variablesManquantes(c.texte, variables);
              const texte = remplacerVariables(c.texte, variables);
              return (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  className="acli-menu__item"
                  data-commande={c.id}
                  aria-disabled={manque.length ? "true" : undefined}
                  title={manque.length ? "Ouvrez d'abord un fichier dans l'éditeur ({fichier})" : texte}
                  onClick={() => {
                    if (manque.length) {
                      setNote(manque.includes("fichier") ? "Ouvrez d'abord un fichier dans l'éditeur." : "Ouvrez d'abord un dossier.");
                      return;
                    }
                    onFermer();
                    onChoisir(texte, c.genre);
                  }}
                >
                  <Icon icon={c.genre === "commande" ? "solar:play-linear" : "solar:document-text-linear"} width={13} height={13} />
                  <span className="acli-menu__libelle">{libelleCommande(c)}</span>
                </button>
              );
            })}
          </Fragment>
        );
      })}
      {note ? <p className="acli-menu__erreur" role="alert">{note}</p> : null}
      <div className="acli-menu__separateur" />
      <button
        type="button"
        role="menuitem"
        className="acli-menu__item"
        data-action="gerer-commandes"
        onClick={() => {
          onFermer();
          ouvrirReglages("commandes");
        }}
      >
        <Icon icon="solar:settings-linear" width={13} height={13} />
        <span className="acli-menu__libelle">Gérer les commandes…</span>
      </button>
    </>
  );
}

/** Barre des terminaux : une commande s'exécute, un prompt est collé sans être validé. */
export function BoutonCommandesTerminal({ dossier, onChoisir }: { dossier: string; onChoisir: (texte: string, genre: GenreCommande) => void }) {
  const bouton = useRef<HTMLButtonElement | null>(null);
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <button
        ref={bouton}
        type="button"
        className="terminal-action"
        data-action="commandes-terminal"
        data-active={ouvert ? "true" : "false"}
        title="Commandes et prompts enregistrés"
        aria-label="Commandes et prompts enregistrés"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        <Icon icon="solar:bookmark-linear" width={14} height={14} />
      </button>
      {ouvert ? (
        <MenuFlottant ancre={bouton.current} onFermer={() => setOuvert(false)} etiquette="Commandes et prompts enregistrés" classe="acli-menu--commandes" largeur={280}>
          <ListeCommandes variables={{ dossier, fichier: fichierActif() }} onChoisir={onChoisir} onFermer={() => setOuvert(false)} />
        </MenuFlottant>
      ) : null}
    </>
  );
}

/** Compositeur du chat : le texte est inséré dans la zone de saisie, jamais envoyé. */
export function BoutonCommandesChat({ dossier, onInserer }: { dossier: string; onInserer: (texte: string) => void }) {
  const bouton = useRef<HTMLButtonElement | null>(null);
  const [ouvert, setOuvert] = useState(false);
  return (
    <>
      <button
        ref={bouton}
        type="button"
        className="composer__iconbtn"
        data-action="commandes-chat"
        title="Insérer un prompt ou une commande enregistrés"
        aria-label="Insérer un prompt ou une commande enregistrés"
        aria-haspopup="menu"
        aria-expanded={ouvert}
        onClick={() => setOuvert((o) => !o)}
      >
        <Icon icon="solar:bookmark-linear" width={16} height={16} />
      </button>
      {ouvert ? (
        <MenuFlottant ancre={bouton.current} onFermer={() => setOuvert(false)} etiquette="Prompts et commandes enregistrés" classe="acli-menu--commandes" largeur={280}>
          <ListeCommandes variables={{ dossier, fichier: fichierActif() }} onChoisir={(texte) => onInserer(texte)} onFermer={() => setOuvert(false)} />
        </MenuFlottant>
      ) : null}
    </>
  );
}

/** Bouton du menu des Réglages. */
export function BoutonReglagesCommandes({ actif, onClick }: { actif: boolean; onClick: () => void }) {
  return (
    <button type="button" className="settings-pane__nav-item" data-section="commandes" data-active={actif ? "true" : "false"} onClick={onClick} title="Commandes et prompts enregistrés">
      <Icon icon="solar:bookmark-linear" width={15} height={15} className="settings-pane__nav-icon" />
      <span className="settings-pane__nav-label">Commandes</span>
      <span className="settings-pane__nav-count" />
    </button>
  );
}

/** Réglages > Commandes : ajouter, modifier, supprimer (enregistré à chaque changement). */
export function ReglagesCommandes() {
  const liste = useCommandesEnregistrees();
  const [nouvelle, setNouvelle] = useState<string | null>(null);
  const changer = (id: string, patch: Partial<CommandeEnregistree>) => ecrireCommandes(liste.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  const ajouter = (genre: GenreCommande) => {
    const c = nouvelleCommande(genre);
    ecrireCommandes([...liste, c]);
    setNouvelle(c.id);
  };
  return (
    <div className="axe-appearance acli-reglages acli-commandes">
      <header>
        <h2 title="Commandes et prompts enregistrés">Commandes et prompts</h2>
        <p className="axe-appearance__hint">
          Terminal : une commande s'exécute, un prompt est collé. Chat : le texte est inséré.
          Variables : {"{dossier}"} et {"{fichier}"} (fichier ouvert dans l'éditeur).
        </p>
      </header>
      <div className="acli-reglages__actions">
        <button type="button" className="axe-appearance__button" data-action="ajouter-commande" onClick={() => ajouter("commande")}>
          Ajouter une commande
        </button>
        <button type="button" className="axe-appearance__button" data-action="ajouter-prompt" onClick={() => ajouter("prompt")}>
          Ajouter un prompt
        </button>
      </div>
      {liste.length === 0 ? <p className="axe-appearance__hint">Aucune commande enregistrée.</p> : null}
      {liste.map((c) => (
        <div key={c.id} className="acli-commande" data-commande={c.id} data-genre={c.genre}>
          <div className="acli-commande__tete">
            <select value={c.genre} aria-label="Genre" onChange={(e) => changer(c.id, { genre: e.target.value === "prompt" ? "prompt" : "commande" })}>
              <option value="commande">Commande</option>
              <option value="prompt">Prompt</option>
            </select>
            <input
              type="text"
              value={c.nom}
              placeholder="Nom"
              aria-label="Nom"
              autoFocus={c.id === nouvelle}
              onChange={(e) => changer(c.id, { nom: e.target.value })}
            />
            <button type="button" className="terminal-action" data-action="supprimer-commande" title="Supprimer" aria-label={`Supprimer ${libelleCommande(c)}`} onClick={() => ecrireCommandes(liste.filter((x) => x.id !== c.id))}>
              <Icon icon="solar:trash-bin-trash-linear" width={14} height={14} />
            </button>
          </div>
          <textarea
            value={c.texte}
            spellCheck={c.genre === "prompt"}
            aria-label="Texte"
            placeholder={c.genre === "commande" ? "npm test" : "Relis {fichier} et propose des corrections."}
            onChange={(e) => changer(c.id, { texte: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

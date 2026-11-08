// Recherche dans le terminal (Ctrl+F quand le terminal a le focus) : sur tout l'historique
// d'xterm, sans dépendance ; Entrée = suivante, Maj+Entrée = précédente, Échap ferme.
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import type { Terminal } from "@xterm/xterm";
import { chercherDansLignes, occurrenceVoisine, type Occurrence } from "./outilsTerminal";
import "./agents-cli.css";

/** Lignes de tout l'historique (tampon actif) du terminal. */
export function lignesTerminal(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) ?? "");
}

export function RechercheTerminal({ terminal, onFermer }: { terminal: Terminal | null; onFermer: () => void }) {
  const champ = useRef<HTMLInputElement | null>(null);
  const [motif, setMotif] = useState("");
  const [casse, setCasse] = useState(false);
  const [courant, setCourant] = useState(-1);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    champ.current?.focus();
    champ.current?.select();
  }, []);

  const occurrences = useMemo<Occurrence[]>(
    () => (terminal ? chercherDansLignes(lignesTerminal(terminal), motif, casse) : []),
    // `version` : relire l'historique (nouvelle sortie) à chaque recherche.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [terminal, motif, casse, version],
  );

  const montrer = (i: number) => {
    setCourant(i);
    const o = occurrences[i];
    if (!terminal || !o) return;
    terminal.select(o.colonne, o.ligne, o.longueur);
    terminal.scrollToLine(Math.max(0, o.ligne - Math.floor(terminal.rows / 2)));
  };

  // Nouveau motif : l'occurrence la plus récente (la plus basse).
  useEffect(() => {
    if (!terminal) return;
    if (!occurrences.length) {
      terminal.clearSelection();
      setCourant(-1);
      return;
    }
    montrer(occurrences.length - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [occurrences]);

  const aller = (sens: 1 | -1) => montrer(occurrenceVoisine(occurrences.length, courant, sens));

  const fermer = () => {
    terminal?.clearSelection();
    onFermer();
    terminal?.focus();
  };

  const compte = !motif ? "" : occurrences.length ? `${courant + 1} / ${occurrences.length}` : "Aucun résultat";
  return (
    <div className="acli-recherche" role="search" aria-label="Rechercher dans le terminal">
      <input
        ref={champ}
        type="text"
        value={motif}
        spellCheck={false}
        placeholder="Rechercher"
        aria-label="Texte à rechercher dans le terminal"
        onChange={(e) => {
          setMotif(e.target.value);
          setVersion((v) => v + 1);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            aller(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            fermer();
          }
        }}
      />
      <span className="acli-recherche__compte" aria-live="polite">{compte}</span>
      <button type="button" className="terminal-action" aria-pressed={casse} data-action="casse" title="Respecter la casse" aria-label="Respecter la casse" onClick={() => setCasse((c) => !c)}>
        <span className="acli-recherche__casse">Aa</span>
      </button>
      <button type="button" className="terminal-action" data-action="precedent" title="Précédent (Maj+Entrée)" aria-label="Occurrence précédente" disabled={!occurrences.length} onClick={() => aller(-1)}>
        <Icon icon="solar:alt-arrow-up-linear" width={14} height={14} />
      </button>
      <button type="button" className="terminal-action" data-action="suivant" title="Suivant (Entrée)" aria-label="Occurrence suivante" disabled={!occurrences.length} onClick={() => aller(1)}>
        <Icon icon="solar:alt-arrow-down-linear" width={14} height={14} />
      </button>
      <button type="button" className="terminal-action" data-action="fermer-recherche" title="Fermer (Échap)" aria-label="Fermer la recherche" onClick={fermer}>
        <Icon icon="solar:close-circle-linear" width={14} height={14} />
      </button>
    </div>
  );
}

// Champ de recherche en haut des Réglages : les sections et les réglages qui
// contiennent les mots tapés (sans casse ni accents) remplacent la liste des sections ; un clic
// (ou ↓ puis Entrée) ouvre la section et signale le réglage. Monté par SettingsPane (une ligne).
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { morceaux } from "./flou";
import { chercherReglages, signalerReglage } from "./rechercheReglages";
import "./palette.css";

type Props = {
  /** Section affichée par le volet. */
  section: string;
  /** Change la section du volet. */
  onSection: (section: string) => void;
};

type Ligne = { cle: string; section: string; titre: string; marques: number[]; icone?: string; reglage: boolean };

// Parties non surlignées en texte simple : un résultat reste un seul texte (2 lignes au plus).
function Texte({ texte, marques }: { texte: string; marques: number[] }) {
  return <>{morceaux(texte, marques).map((m, i) => (m.marque ? <mark key={i}>{m.texte}</mark> : m.texte))}</>;
}

export function RechercheReglages({ section, onSection }: Props) {
  const [requete, setRequete] = useState("");
  const [actif, setActif] = useState(0);
  const champRef = useRef<HTMLInputElement | null>(null);
  const idListe = useId();
  const lignes = useMemo<Ligne[]>(() => {
    const sortie: Ligne[] = [];
    for (const s of chercherReglages(requete)) {
      sortie.push({ cle: s.section.id, section: s.section.id, titre: s.section.titre, marques: s.marques, icone: s.section.icone, reglage: false });
      for (const r of s.reglages.slice(0, 8)) {
        sortie.push({ cle: `${s.section.id}:${r.reglage.titre}`, section: s.section.id, titre: r.reglage.titre, marques: r.marques, reglage: true });
      }
    }
    return sortie;
  }, [requete]);
  useEffect(() => setActif(0), [lignes]);

  const aller = (l: Ligne) => {
    onSection(l.section);
    if (l.reglage) signalerReglage(l.titre);
  };
  const touche = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape" && requete) {
      e.preventDefault();
      e.stopPropagation();
      setRequete("");
    } else if (e.key === "ArrowDown" && lignes.length) {
      e.preventDefault();
      setActif((i) => (i + 1) % lignes.length);
    } else if (e.key === "ArrowUp" && lignes.length) {
      e.preventDefault();
      setActif((i) => (i - 1 + lignes.length) % lignes.length);
    } else if (e.key === "Enter" && lignes[actif]) {
      e.preventDefault();
      aller(lignes[actif]);
    }
  };

  const enCours = requete.trim().length > 0;
  return (
    <div className="recherche-reglages" data-active={enCours ? "true" : "false"}>
      <div className="recherche-reglages__champ" title="Rechercher dans les Réglages">
        <Icon icon="solar:magnifer-linear" width={13} height={13} aria-hidden />
        <input
          ref={champRef}
          value={requete}
          placeholder="Rechercher"
          spellCheck={false}
          aria-label="Rechercher dans les Réglages"
          role="combobox"
          aria-expanded={enCours}
          aria-controls={idListe}
          aria-activedescendant={enCours && lignes[actif] ? `${idListe}-${actif}` : undefined}
          onChange={(e) => setRequete(e.target.value)}
          onKeyDown={touche}
        />
        {enCours ? (
          <button
            type="button"
            className="recherche-reglages__effacer"
            title="Effacer la recherche"
            aria-label="Effacer la recherche"
            onClick={() => {
              setRequete("");
              champRef.current?.focus();
            }}
          >
            <Icon icon="solar:close-circle-linear" width={13} height={13} />
          </button>
        ) : null}
      </div>
      {enCours ? (
        <div className="recherche-reglages__resultats" role="listbox" id={idListe} aria-label="Réglages trouvés">
          {lignes.length ? (
            lignes.map((l, i) => (
              <div
                key={l.cle}
                id={`${idListe}-${i}`}
                role="option"
                aria-selected={i === actif}
                className="recherche-reglages__ligne"
                data-genre={l.reglage ? "reglage" : "section"}
                data-section={l.section}
                data-actif={i === actif ? "true" : "false"}
                data-active={!l.reglage && l.section === section ? "true" : "false"}
                title={l.titre}
                onPointerMove={() => i !== actif && setActif(i)}
                onClick={() => aller(l)}
              >
                {l.icone ? <Icon icon={l.icone} width={15} height={15} className="recherche-reglages__icone" aria-hidden /> : null}
                <span className="recherche-reglages__texte">
                  <Texte texte={l.titre} marques={l.marques} />
                </span>
              </div>
            ))
          ) : (
            <div className="recherche-reglages__vide">Aucun réglage ne correspond</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

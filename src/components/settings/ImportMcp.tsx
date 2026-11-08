// Réglages > MCP, bouton « Importer » : serveurs déclarés pour Claude
// Code, Codex, Cursor et VS Code, à cocher. Doublons signalés ; aucune valeur
// secrète n'arrive jusqu'ici (le service relit les fichiers au moment d'importer).
import { useCallback, useEffect, useState } from "react";
import { Icon } from "@iconify/react";
import { interopApi } from "../../lib/interopApi";
import {
  EVENEMENT_IMPORT_MCP,
  detail,
  grouper,
  importable,
  prendreDemandeImportMcp,
  resumeMcp,
  selectionDeDepart,
  type ServeurTrouve,
} from "../../lib/importMcp";
import "./interop.css";

type Props = { workspacePath: string; onImported?: () => void };

export function ImportMcp({ workspacePath, onImported }: Props) {
  const [ouvert, setOuvert] = useState(false);

  useEffect(() => {
    // Demande venue de la proposition du premier lancement (avant ou après le montage).
    if (prendreDemandeImportMcp()) setOuvert(true);
    const ouvrir = () => {
      prendreDemandeImportMcp();
      setOuvert(true);
    };
    window.addEventListener(EVENEMENT_IMPORT_MCP, ouvrir);
    return () => window.removeEventListener(EVENEMENT_IMPORT_MCP, ouvrir);
  }, []);

  return (
    <>
      <button
        type="button"
        className="settings-pane__btn"
        data-action="importer-mcp"
        title="Reprendre les serveurs MCP de Claude Code, Codex, Cursor ou VS Code"
        onClick={() => setOuvert(true)}
      >
        <Icon icon="solar:import-linear" width={13} height={13} />
        <span>Importer</span>
      </button>
      {ouvert ? <BoiteImportMcp workspacePath={workspacePath} onImported={onImported} onFermer={() => setOuvert(false)} /> : null}
    </>
  );
}

function BoiteImportMcp({ workspacePath, onImported, onFermer }: Props & { onFermer: () => void }) {
  const [liste, setListe] = useState<ServeurTrouve[] | null>(null);
  const [choix, setChoix] = useState<Set<string>>(new Set());
  const [occupe, setOccupe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(async () => {
    try {
      const l = await interopApi.mcpScanner(workspacePath);
      setListe(l);
      setChoix(selectionDeDepart(l));
      setErreur(null);
    } catch (e) {
      setListe([]);
      setErreur(String(e));
    }
  }, [workspacePath]);

  useEffect(() => {
    void charger();
  }, [charger]);

  const importer = async () => {
    setOccupe(true);
    setMessage(null);
    try {
      const r = await interopApi.mcpImporter(workspacePath, [...choix]);
      setMessage(resumeMcp(r));
      if (r.importes.length) onImported?.();
      await charger();
    } catch (e) {
      setErreur(String(e));
    } finally {
      setOccupe(false);
    }
  };

  const basculer = (cle: string) =>
    setChoix((avant) => {
      const apres = new Set(avant);
      if (apres.has(cle)) apres.delete(cle);
      else apres.add(cle);
      return apres;
    });

  return (
    <div
      className="axe-harnais-modal"
      role="presentation"
      onKeyDown={(e) => e.key === "Escape" && onFermer()}
      onMouseDown={(e) => e.target === e.currentTarget && onFermer()}
    >
      <div className="axe-harnais-boite axe-interop__boite" role="dialog" aria-modal="true" aria-labelledby="axe-interop-mcp-titre">
        <h3 id="axe-interop-mcp-titre">Importer des serveurs MCP</h3>
        <p className="axe-harness__muted">Serveurs déclarés sur ce poste pour Claude Code, Codex, Cursor et VS Code. Les valeurs secrètes ne sont jamais affichées.</p>
        {!liste ? (
          <p className="axe-harness__muted">Lecture des fichiers de configuration…</p>
        ) : liste.length === 0 ? (
          <p className="axe-harness__muted">Aucun serveur trouvé (~/.claude.json, .mcp.json, ~/.codex/config.toml, ~/.cursor/mcp.json, .vscode/mcp.json).</p>
        ) : (
          grouper(liste).map((g) => (
            <section key={g.titre} className="axe-interop__groupe">
              <h4>{g.titre}</h4>
              <ul className="axe-interop__liste">
                {g.serveurs.map((s) => (
                  <li key={s.cle} data-doublon={s.doublon ? "true" : undefined}>
                    <label title={detail(s)}>
                      <input type="checkbox" disabled={!importable(s) || occupe} checked={choix.has(s.cle)} onChange={() => basculer(s.cle)} />
                      <strong>{s.nom}</strong>
                      <code className="axe-interop__desc">{detail(s)}</code>
                    </label>
                    {s.doublon || s.avertissement ? (
                      <span className="axe-interop__note" data-genre={s.doublon ? "doublon" : "avertissement"} title={[s.doublon, s.avertissement].filter(Boolean).join(" ; ")}>
                        {[s.doublon, s.avertissement].filter(Boolean).join(" ; ")}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {message ? <p className="axe-harness__status" role="status">{message}</p> : null}
        {erreur ? <p className="axe-harness__error">{erreur}</p> : null}
        <div className="axe-harness__actions">
          <button
            type="button"
            autoFocus
            className="axe-harness__btn axe-harness__btn--primary"
            data-action="importer-mcp-confirmer"
            disabled={occupe || choix.size === 0}
            onClick={() => void importer()}
          >
            {occupe ? "Import…" : `Importer (${choix.size})`}
          </button>
          <button type="button" className="axe-harness__btn" onClick={onFermer}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}

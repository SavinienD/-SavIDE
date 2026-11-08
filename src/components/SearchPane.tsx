import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@iconify/react";
import { invoke } from "@tauri-apps/api/core";
import { api, cloudConnectionFromPath } from "../lib/ipc";
import {
  dansDossier,
  dossierDeRecherche,
  EVENEMENT_RECHERCHE_DOSSIER,
  oublierRechercheDossier,
} from "./palette/rechercheDossier"; // lot palette : « Rechercher dans ce dossier »
import { fileIcon } from "../lib/fileIcon";
import type {
  EditorRevealTarget,
  WorkspaceEntry,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
} from "../types";

type Props = {
  workspacePath: string;
  refreshToken?: number;
  onOpenFile: (
    entry: WorkspaceEntry,
    reveal?: Omit<EditorRevealTarget, "id" | "relativePath">,
  ) => void;
};

const SEARCH_DELAY_MS = 180;

// lot palette — recherche limitée à un sous-dossier (clic droit dans l'explorateur) ; un espace
// cloud est filtré après coup (la recherche du service n'a pas de dossier).
function chercher(workspacePath: string, query: string, dossier: string | null): Promise<WorkspaceSearchResult> {
  if (!dossier) return api.searchWorkspace(workspacePath, query);
  if (cloudConnectionFromPath(workspacePath)) {
    return api
      .searchWorkspace(workspacePath, query)
      .then((r) => ({ ...r, files: r.files.filter((f) => dansDossier(f.relativePath, dossier)) }));
  }
  return invoke<WorkspaceSearchResult>("palette_recherche_dossier", { input: { workspacePath, dossier, query } });
}

export function SearchPane({ workspacePath, refreshToken, onOpenFile }: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<WorkspaceSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestSeqRef = useRef(0);
  // lot palette — dossier auquel la recherche est limitée (null : tout le dossier ouvert).
  const [dossier, setDossier] = useState<string | null>(() => dossierDeRecherche());
  useEffect(() => {
    const changer = (e: Event) => {
      setDossier((e as CustomEvent<{ dossier: string | null }>).detail?.dossier ?? null);
      inputRef.current?.focus();
    };
    window.addEventListener(EVENEMENT_RECHERCHE_DOSSIER, changer);
    return () => {
      window.removeEventListener(EVENEMENT_RECHERCHE_DOSSIER, changer);
      oublierRechercheDossier();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    requestSeqRef.current += 1;
    const seq = requestSeqRef.current;

    if (!trimmed) {
      setLoading(false);
      setError(null);
      setResult(null);
      return;
    }

    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void chercher(workspacePath, trimmed, dossier)
        .then((next) => {
          if (seq !== requestSeqRef.current) return;
          setResult(next);
        })
        .catch((err) => {
          if (seq !== requestSeqRef.current) return;
          setResult(null);
          setError(String(err));
        })
        .finally(() => {
          if (seq === requestSeqRef.current) setLoading(false);
        });
    }, SEARCH_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [query, refreshToken, workspacePath, dossier]);

  const openFile = useCallback(
    (
      file: WorkspaceSearchResult["files"][number],
      match = file.matches[0],
    ) => {
      onOpenFile(
        {
          name: file.name,
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
          kind: "file",
          hasChildren: false,
        },
        match
          ? {
              lineNumber: match.lineNumber,
              columnStart: match.columnStart,
              columnEnd: match.columnEnd,
              query,
            }
          : undefined,
      );
    },
    [onOpenFile, query],
  );

  const files = result?.files ?? [];
  const hasQuery = query.trim().length > 0;

  return (
    <div className="search-pane">
      <div className="search-pane__field">
        <Icon icon="solar:magnifer-linear" width={14} height={14} />
        <input
          ref={inputRef}
          value={query}
          placeholder="Rechercher"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setQuery("");
            }
          }}
        />
        {query && (
          <button
            type="button"
            className="search-pane__clear"
            title="Effacer"
            onClick={() => setQuery("")}
          >
            <Icon icon="solar:close-circle-linear" width={14} height={14} />
          </button>
        )}
      </div>
      {dossier ? (
        <div className="search-pane__dossier" title={`Recherche limitée à ${dossier}`}>
          <span className="search-pane__dossier-nom">Dans {dossier}</span>
          <button
            type="button"
            title="Rechercher dans tout le dossier"
            aria-label="Rechercher dans tout le dossier"
            onClick={() => {
              oublierRechercheDossier();
              setDossier(null);
              inputRef.current?.focus();
            }}
          >
            <Icon icon="solar:close-circle-linear" width={13} height={13} />
          </button>
        </div>
      ) : null}

      <div className="search-pane__meta">
        {loading
          ? "Recherche…"
          : error
            ? error
            : hasQuery
              ? `${files.length} fichiers, ${result?.totalMatches ?? 0} résultats`
              : dossier
                ? `Rechercher dans ${dossier}`
                : "Rechercher dans les fichiers"}
      </div>

      <div className="search-pane__results">
        {files.map((file) => (
          <div key={file.relativePath} className="search-result">
            <button
              type="button"
              className="search-result__file"
              title={file.relativePath}
              onClick={() => openFile(file)}
            >
              <span className="search-result__icon">
                <Icon icon={fileIcon(file.name)} width={15} height={15} />
              </span>
              <span className="search-result__path">{file.relativePath}</span>
              <span className="search-result__count">
                {file.matchCount || (file.pathMatch ? "chemin" : 0)}
              </span>
            </button>

            {file.matches.length > 0 ? (
              <div className="search-result__matches">
                {file.matches.map((match) => (
                  <button
                    type="button"
                    key={`${file.relativePath}:${match.lineNumber}:${match.lineText}`}
                    className="search-result__match"
                    onClick={() => openFile(file, match)}
                  >
                    <span className="search-result__text">
                      {highlightMatch(match)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="search-result__path-match">Chemin correspondant</div>
            )}
          </div>
        ))}
        {hasQuery && !loading && !error && files.length === 0 && (
          <div className="search-pane__empty">Aucun résultat</div>
        )}
      </div>
    </div>
  );
}

function highlightMatch(match: WorkspaceSearchMatch): ReactNode {
  const start = Math.max(0, Math.min(match.matchStart, match.lineText.length));
  const end = Math.max(start, Math.min(match.matchEnd, match.lineText.length));
  if (start === end) return match.lineText;
  return (
    <>
      {match.lineText.slice(0, start)}
      <mark>{match.lineText.slice(start, end)}</mark>
      {match.lineText.slice(end)}
    </>
  );
}

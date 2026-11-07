import { Icon } from "@iconify/react";
import { api } from "../../lib/ipc";
import { Markdown } from "../chat/Markdown";
import { formatDate, type HarnessEntry } from "./harnessApi";

// cleanup — Settings > Skills: preview of a harness Python skill
// (package `<name>/__init__.py` + SKILL.md), next to the Markdown recipes.

export function isPySkillEnabled(entry: HarnessEntry): boolean {
  return !entry.tags.includes("disabled");
}

export function PythonSkillPreview({
  entry,
  busy,
  onToggle,
  onMove,
  onPartager,
}: {
  entry: HarnessEntry;
  busy: boolean;
  onToggle: () => void;
  onMove: () => void;
  /** ouvre le menu « Exporter en .md… / Copier en Markdown » (clavier, tactile). */
  onPartager?: (x: number, y: number) => void;
}) {
  const dir = entry.packageDir ?? entry.path;
  const sep = dir.includes("\\") ? "\\" : "/";
  return (
    <div className="settings-pane__pyskill">
      <header className="settings-pane__pyskill-head">
        <div>
          <h2>
            <code>import {entry.title}</code>
          </h2>
          <p className="settings-pane__muted">
            Skill Python du harnais · {entry.scope === "global" ? "global" : "projet"} · source{" "}
            {entry.source || "—"} · modifié {formatDate(entry.updated)}
          </p>
        </div>
        <div className="settings-pane__actions">
          <button type="button" className="settings-pane__btn" disabled={busy} onClick={onToggle}>
            {isPySkillEnabled(entry) ? "Désactiver" : "Activer"}
          </button>
          <button type="button" className="settings-pane__btn" disabled={busy} onClick={onMove}>
            {entry.scope === "project" ? "Promouvoir en global" : "Dégrader en projet"}
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => void api.openPathWithDefaultApp(`${dir}${sep}__init__.py`)}
          >
            <Icon icon="solar:code-file-linear" width={13} height={13} />
            <span>Ouvrir le code</span>
          </button>
          <button
            type="button"
            className="settings-pane__btn"
            onClick={() => void api.revealAbsolutePath(dir)}
          >
            <Icon icon="solar:folder-open-linear" width={13} height={13} />
            <span>Dossier</span>
          </button>
          {onPartager ? (
            <button
              type="button"
              className="settings-pane__btn"
              data-action="partager-skill"
              title="Exporter ou copier en Markdown (SKILL.md + code Python)"
              onClick={(event) => {
                const r = event.currentTarget.getBoundingClientRect();
                onPartager(r.left, r.bottom + 2);
              }}
            >
              <Icon icon="solar:share-linear" width={13} height={13} />
              <span>Partager…</span>
            </button>
          ) : null}
        </div>
      </header>
      <p className="settings-pane__muted">
        <code>{dir}</code>
      </p>
      <div className="settings-pane__pyskill-body">
        <Markdown text={entry.body || "_Pas de description._"} onOpenFile={() => {}} />
      </div>
    </div>
  );
}

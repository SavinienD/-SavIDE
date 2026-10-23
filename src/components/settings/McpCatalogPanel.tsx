// axe:e7 — formulaire d'ajout d'un serveur MCP depuis le catalogue.
// On choisit une entrée, on colle la clé API (saisie masquée) et on ajoute :
// la configuration réelle est écrite et l'état est ensuite affiché sans jamais
// montrer la clé.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  buildMcpServerFromCatalog,
  MCP_CATALOG,
  type McpCatalogEntry,
} from "../../axe/mcpCatalog";
import type { McpServerConfig } from "../../types";

type Props = {
  busy: boolean;
  error: string | null;
  onAdd: (server: McpServerConfig) => Promise<boolean>;
  onCancel: () => void;
};

export function McpCatalogPanel({ busy, error, onAdd, onCancel }: Props) {
  const [selectedId, setSelectedId] = useState<string>(MCP_CATALOG[0].id);
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selected: McpCatalogEntry = useMemo(
    () => MCP_CATALOG.find((entry) => entry.id === selectedId) ?? MCP_CATALOG[0],
    [selectedId],
  );

  const missingRequired = selected.vars.some(
    (variable) =>
      variable.required && !(values[variable.key] ?? "").trim(),
  );

  const selectEntry = (id: string) => {
    setSelectedId(id);
    setValues({});
    setSubmitError(null);
  };

  const submit = async () => {
    if (busy || missingRequired) return;
    setSubmitError(null);
    const server = buildMcpServerFromCatalog(selected, values);
    const ok = await onAdd(server);
    if (!ok) {
      setSubmitError("Impossible d'ajouter ce serveur.");
    }
  };

  return (
    <div className="settings-pane__mcp-catalog">
      <div className="settings-pane__mcp-catalog-head">
        <div>
          <span className="settings-pane__detail-title">Ajouter un serveur</span>
          <p className="settings-pane__mcp-catalog-sub">
            Choisissez un serveur courant, collez la clé demandée : la
            configuration est écrite automatiquement.
          </p>
        </div>
        <button
          type="button"
          className="settings-pane__btn"
          onClick={onCancel}
          disabled={busy}
        >
          <Icon icon="solar:close-circle-linear" width={13} height={13} />
          <span>Annuler</span>
        </button>
      </div>

      <div className="settings-pane__mcp-catalog-body">
        <div className="settings-pane__server-grid" role="list">
          {MCP_CATALOG.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="listitem"
              className="settings-pane__mcp-catalog-item"
              data-active={entry.id === selectedId ? "true" : "false"}
              onClick={() => selectEntry(entry.id)}
            >
              <span className="settings-pane__mcp-catalog-item-name">
                {entry.name}
              </span>
              <span className="settings-pane__mcp-catalog-item-desc">
                {entry.description}
              </span>
            </button>
          ))}
        </div>

        <div className="settings-pane__mcp-catalog-form">
          <div className="settings-pane__mcp-catalog-form-head">
            <span className="settings-pane__detail-section">{selected.name}</span>
            <code className="settings-pane__mcp-catalog-install">
              {selected.install}
            </code>
          </div>

          {selected.vars.length === 0 ? (
            <p className="settings-pane__muted">
              Aucune clé requise pour ce serveur.
            </p>
          ) : (
            selected.vars.map((variable) => (
              <label className="settings-pane__mcp-catalog-field" key={variable.key}>
                <span className="settings-pane__mcp-catalog-field-label">
                  {variable.label}
                  {variable.required ? " *" : ""}
                </span>
                <input
                  type={variable.secret ? "password" : "text"}
                  value={values[variable.key] ?? ""}
                  placeholder={variable.placeholder}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [variable.key]: event.target.value,
                    }))
                  }
                />
                {variable.help && (
                  <span className="settings-pane__mcp-catalog-field-help">
                    {variable.help}
                  </span>
                )}
              </label>
            ))
          )}

          {selected.note && (
            <p className="settings-pane__mcp-catalog-note">{selected.note}</p>
          )}

          <div className="settings-pane__mcp-catalog-actions">
            <button
              type="button"
              className="settings-pane__btn"
              data-primary="true"
              onClick={() => void submit()}
              disabled={busy || missingRequired}
            >
              <Icon
                icon={busy ? "solar:refresh-linear" : "solar:add-circle-linear"}
                width={13}
                height={13}
              />
              <span>{busy ? "Vérification…" : "Ajouter"}</span>
            </button>
            <span className="settings-pane__mcp-catalog-hint">
              La clé n'est jamais affichée ni journalisée.
            </span>
          </div>

          {(submitError || error) && (
            <div className="settings-pane__editor-error">
              <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
              <span>{submitError ?? error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

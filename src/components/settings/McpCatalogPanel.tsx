// e7 — formulaire d'ajout d'un serveur MCP depuis le catalogue.
// mcp-guide — catalogue rangé (programmes locaux, serveurs distants, autres IA),
// ajout guidé d'un serveur personnalisé (stdio ou HTTP), « Tester » avant d'ajouter,
// et connexion par le navigateur (OAuth MCP) pour les serveurs distants qui la gèrent.
import { useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  buildMcpServerFromCatalog,
  MCP_CATALOG,
  type McpCatalogEntry,
} from "../../axe/mcpCatalog";
import {
  construireServeurPerso,
  SAISIE_PERSO_VIDE,
  validerServeurPerso,
  type SaisieServeurPerso,
} from "../../axe/mcpGuide";
import type { McpServerConfig, McpServerProbe } from "../../types";
import { ResultatTestMcp } from "./McpErreur";

type Props = {
  busy: boolean;
  error: string | null;
  existingIds: string[];
  onAdd: (server: McpServerConfig, connecter: boolean) => Promise<boolean>;
  onTest: (server: McpServerConfig) => Promise<McpServerProbe>;
  onCancel: () => void;
};

const PERSO = "perso";

const GROUPES: { id: "local" | "distant" | "ia"; titre: string; aide?: string }[] = [
  { id: "distant", titre: "Serveurs distants", aide: "Rien à installer. « Connexion navigateur » : pas de jeton à coller." },
  { id: "ia", titre: "Autres IA", aide: "L'agent leur confie une question ou une tâche, avec le compte déjà connecté sur ce poste." },
  { id: "local", titre: "Programmes sur ce poste" },
];

type EtatTest = { etat: "repos" } | { etat: "en-cours" } | { etat: "fini"; probe: McpServerProbe } | { etat: "echec"; message: string };

export function McpCatalogPanel({ busy, error, existingIds, onAdd, onTest, onCancel }: Props) {
  const [selectedId, setSelectedId] = useState<string>(PERSO);
  const [values, setValues] = useState<Record<string, string>>({});
  const [perso, setPerso] = useState<SaisieServeurPerso>(SAISIE_PERSO_VIDE);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [test, setTest] = useState<EtatTest>({ etat: "repos" });

  const selected: McpCatalogEntry | null = useMemo(
    () => (selectedId === PERSO ? null : MCP_CATALOG.find((entry) => entry.id === selectedId) ?? null),
    [selectedId],
  );

  const persoErreur = selected ? null : validerServeurPerso(perso);
  const missingRequired = selected
    ? selected.vars.some((variable) => variable.required && !(values[variable.key] ?? "").trim())
    : Boolean(persoErreur);

  const serveur = (): McpServerConfig =>
    selected ? buildMcpServerFromCatalog(selected, values) : construireServeurPerso(perso, existingIds);

  const selectEntry = (id: string) => {
    setSelectedId(id);
    setValues({});
    setSubmitError(null);
    setTest({ etat: "repos" });
  };

  const changerPerso = (patch: Partial<SaisieServeurPerso>) => {
    setPerso((courant) => ({ ...courant, ...patch }));
    setTest({ etat: "repos" });
  };

  const tester = async () => {
    if (missingRequired || test.etat === "en-cours") return;
    setTest({ etat: "en-cours" });
    try {
      setTest({ etat: "fini", probe: await onTest(serveur()) });
    } catch (err) {
      setTest({ etat: "echec", message: err instanceof Error ? err.message : String(err) });
    }
  };

  const connecter = Boolean(selected?.oauth);
  const submit = async () => {
    if (busy || missingRequired) return;
    setSubmitError(null);
    const ok = await onAdd(serveur(), connecter);
    if (!ok) setSubmitError("Impossible d'ajouter ce serveur.");
  };

  const tuile = (entry: McpCatalogEntry) => (
    <button
      key={entry.id}
      type="button"
      role="listitem"
      className="settings-pane__mcp-catalog-item"
      data-entry={entry.id}
      data-active={entry.id === selectedId ? "true" : "false"}
      onClick={() => selectEntry(entry.id)}
    >
      <span className="settings-pane__mcp-catalog-item-name">
        {entry.name}
        {entry.oauth && <span className="settings-pane__mcp-badge" data-kind="oauth">Connexion navigateur</span>}
      </span>
      <span className="settings-pane__mcp-catalog-item-desc" title={entry.description}>{entry.description}</span>
    </button>
  );

  return (
    <div className="settings-pane__mcp-catalog">
      <div className="settings-pane__mcp-catalog-head">
        <div>
          <span className="settings-pane__detail-title settings-pane__mcp-catalog-title" title="Ajouter un serveur">Ajouter un serveur</span>
          <p className="settings-pane__mcp-catalog-sub">
            Choisissez un modèle prêt à l'emploi ou décrivez votre serveur, testez-le, puis ajoutez-le.
          </p>
        </div>
        <button type="button" className="settings-pane__btn" onClick={onCancel} disabled={busy}>
          <Icon icon="solar:close-circle-linear" width={13} height={13} />
          <span>Annuler</span>
        </button>
      </div>

      <div className="settings-pane__mcp-catalog-body">
        <div className="settings-pane__server-grid" role="list">
          <button
            type="button"
            role="listitem"
            className="settings-pane__mcp-catalog-item"
            data-entry={PERSO}
            data-active={selectedId === PERSO ? "true" : "false"}
            onClick={() => selectEntry(PERSO)}
          >
            <span className="settings-pane__mcp-catalog-item-name">Serveur personnalisé</span>
            <span className="settings-pane__mcp-catalog-item-desc" title="Programme local (stdio) ou adresse d'un serveur distant (HTTP).">Programme local (stdio) ou adresse d'un serveur distant (HTTP).</span>
          </button>
          {GROUPES.map((groupe) => {
            const entrees = MCP_CATALOG.filter((entry) => (entry.categorie ?? "local") === groupe.id);
            if (entrees.length === 0) return null;
            return (
              <div key={groupe.id} className="settings-pane__mcp-catalog-group" data-groupe={groupe.id}>
                <span className="settings-pane__mcp-catalog-group-title">{groupe.titre}</span>
                {groupe.aide && <span className="settings-pane__mcp-catalog-field-help">{groupe.aide}</span>}
                {entrees.map(tuile)}
              </div>
            );
          })}
        </div>

        <div className="settings-pane__mcp-catalog-form">
          {selected ? (
            <>
              <div className="settings-pane__mcp-catalog-form-head">
                <span className="settings-pane__detail-section">{selected.name}</span>
                <code className="settings-pane__mcp-catalog-install">{selected.install}</code>
              </div>
              {selected.vars.length === 0 ? (
                <p className="settings-pane__muted">
                  {selected.oauth
                    ? "Aucun jeton à coller : « Ajouter et se connecter » ouvre le navigateur pour autoriser SavIDE."
                    : "Aucune clé requise pour ce serveur."}
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
                      onChange={(event) => {
                        setValues((current) => ({ ...current, [variable.key]: event.target.value }));
                        setTest({ etat: "repos" });
                      }}
                    />
                    {variable.help && <span className="settings-pane__mcp-catalog-field-help">{variable.help}</span>}
                  </label>
                ))
              )}
              {selected.note && <p className="settings-pane__mcp-catalog-note">{selected.note}</p>}
            </>
          ) : (
            <>
              <div className="settings-pane__mcp-mode" role="radiogroup" aria-label="Type de serveur">
                {(["stdio", "http"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={perso.mode === mode}
                    className="settings-pane__mcp-mode-btn"
                    data-mode={mode}
                    data-on={perso.mode === mode ? "true" : "false"}
                    onClick={() => changerPerso({ mode })}
                    title={mode === "stdio" ? "Programme lancé sur ce poste (stdio)" : "Serveur distant joint par son adresse (HTTP)"}
                  >
                    <span>{mode === "stdio" ? "Local (stdio)" : "Distant (HTTP)"}</span>
                  </button>
                ))}
              </div>
              <label className="settings-pane__mcp-catalog-field">
                <span className="settings-pane__mcp-catalog-field-label">Nom *</span>
                <input data-champ="nom" value={perso.nom} placeholder="ex. Mon serveur" spellCheck={false} onChange={(e) => changerPerso({ nom: e.target.value })} />
              </label>
              {perso.mode === "stdio" ? (
                <>
                  <label className="settings-pane__mcp-catalog-field">
                    <span className="settings-pane__mcp-catalog-field-label">Commande *</span>
                    <input data-champ="commande" value={perso.commande} placeholder="npx -y @scope/serveur-mcp" spellCheck={false} onChange={(e) => changerPerso({ commande: e.target.value })} />
                    <span className="settings-pane__mcp-catalog-field-help">Telle qu'on la tape dans un terminal (guillemets acceptés).</span>
                  </label>
                  <label className="settings-pane__mcp-catalog-field">
                    <span className="settings-pane__mcp-catalog-field-label">Variables d'environnement</span>
                    <textarea data-champ="env" value={perso.env} rows={2} placeholder="API_KEY=…" spellCheck={false} onChange={(e) => changerPerso({ env: e.target.value })} />
                    <span className="settings-pane__mcp-catalog-field-help">Une par ligne : CLE=valeur. Les clés et jetons ne sont jamais affichés ensuite.</span>
                  </label>
                </>
              ) : (
                <>
                  <label className="settings-pane__mcp-catalog-field">
                    <span className="settings-pane__mcp-catalog-field-label">Adresse *</span>
                    <input data-champ="url" value={perso.url} placeholder="https://exemple.fr/mcp" spellCheck={false} onChange={(e) => changerPerso({ url: e.target.value })} />
                  </label>
                  <label className="settings-pane__mcp-catalog-field">
                    <span className="settings-pane__mcp-catalog-field-label">Jeton (facultatif)</span>
                    <input data-champ="jeton" type="password" value={perso.jeton} autoComplete="off" spellCheck={false} onChange={(e) => changerPerso({ jeton: e.target.value })} />
                    <span className="settings-pane__mcp-catalog-field-help">
                      Laissez vide si le serveur propose la connexion par le navigateur : « Se connecter » apparaîtra après l'ajout.
                    </span>
                  </label>
                </>
              )}
              {persoErreur && (perso.nom || perso.commande || perso.url) && (
                <p className="settings-pane__mcp-catalog-note" data-tone="error">{persoErreur}</p>
              )}
            </>
          )}

          <div className="settings-pane__mcp-catalog-actions">
            <button
              type="button"
              className="settings-pane__btn settings-pane__mcp-tester"
              onClick={() => void tester()}
              disabled={busy || missingRequired || test.etat === "en-cours"}
            >
              <Icon icon={test.etat === "en-cours" ? "solar:refresh-linear" : "solar:plug-circle-linear"} width={13} height={13} />
              <span>{test.etat === "en-cours" ? "Test…" : "Tester"}</span>
            </button>
            <button
              type="button"
              className="settings-pane__btn settings-pane__mcp-ajouter"
              data-primary="true"
              onClick={() => void submit()}
              disabled={busy || missingRequired}
            >
              <Icon icon={busy ? "solar:refresh-linear" : connecter ? "solar:login-2-linear" : "solar:add-circle-linear"} width={13} height={13} />
              <span>{busy ? "Vérification…" : connecter ? "Ajouter et se connecter" : "Ajouter"}</span>
            </button>
          </div>

          {test.etat === "fini" && <ResultatTestMcp probe={test.probe} />}
          {test.etat === "echec" && (
            <div className="settings-pane__editor-error">
              <Icon icon="solar:danger-triangle-linear" width={13} height={13} />
              <span>{test.message}</span>
            </div>
          )}

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

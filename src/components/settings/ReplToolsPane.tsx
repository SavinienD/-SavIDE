import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReplServicesSection } from "./ReplServicesSection"; // axe:cleanup
import "./repl.css";
import { useModelChoices } from "../agents/useModelChoices"; // axe:sub-m

// axe:repl — Settings > Outils (REPL): modules and functions exposed in the
// Python kernel. Disabled entries are neither imported nor described to the
// model. Also hosts the compaction threshold and the per-model output caps.

type FunctionSetting = { enabled: boolean; description?: string | null };
type ModuleSetting = {
  enabled: boolean;
  description?: string | null;
  functions: Record<string, FunctionSetting>;
};
export type ReplSettings = {
  agentEnabled: boolean;
  modules: Record<string, ModuleSetting>;
  compactionThreshold: number;
  maxOutputTokens: Record<string, number>;
  outputCapChars: number;
  maxRounds: number;
  /** axe:sub-m — `provider/model` for rlm.spawn without `model` (null = parent's model). */
  subagentDefaultModel?: string | null;
};
type CatalogFunction = { name: string; signature: string; doc: string; default_doc?: string };
type CatalogModule = { name: string; doc: string; default_doc?: string; functions: CatalogFunction[] };

const emptyModule = (): ModuleSetting => ({ enabled: true, functions: {} });

function firstParagraph(doc: string): string {
  return (doc || "").split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
}

export function ReplToolsPane({ workspacePath }: { workspacePath: string }) {
  const [settings, setSettings] = useState<ReplSettings | null>(null);
  const [saved, setSaved] = useState("");
  const [catalog, setCatalog] = useState<CatalogModule[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [newModelKey, setNewModelKey] = useState("");
  const modelChoices = useModelChoices(); // axe:sub-m

  useEffect(() => {
    invoke<ReplSettings>("repl_settings_get")
      .then((value) => {
        setSettings(value);
        setSaved(JSON.stringify(value));
      })
      .catch((err) => setStatus(String(err)));
    invoke<{ modules: CatalogModule[] }>("repl_catalog")
      .then((value) => setCatalog(value.modules))
      .catch((err) => setCatalogError(String(err)));
  }, []);

  const dirty = settings !== null && JSON.stringify(settings) !== saved;

  const save = useCallback(async () => {
    if (!settings) return;
    try {
      const value = await invoke<ReplSettings>("repl_settings_save", { input: { settings } });
      setSettings(value);
      setSaved(JSON.stringify(value));
      setStatus("Enregistré. Les nouvelles sessions et le prochain redémarrage du kernel appliquent la configuration.");
    } catch (err) {
      setStatus(String(err));
    }
  }, [settings]);

  const update = (fn: (draft: ReplSettings) => void) =>
    setSettings((current) => {
      if (!current) return current;
      const draft: ReplSettings = JSON.parse(JSON.stringify(current));
      fn(draft);
      return draft;
    });

  const moduleSetting = (name: string): ModuleSetting => settings?.modules[name] ?? emptyModule();
  const editModule = (name: string, fn: (m: ModuleSetting) => void) =>
    update((draft) => {
      const current = draft.modules[name] ?? emptyModule();
      fn(current);
      draft.modules[name] = current;
    });

  const enabledCount = useMemo(
    () => (catalog ?? []).filter((m) => moduleSetting(m.name).enabled).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog, settings],
  );

  if (!settings) {
    return <div className="axe-repl"><p className="axe-repl__muted">{status ?? "Chargement…"}</p></div>;
  }

  return (
    <div className="axe-repl">
      <header className="axe-repl__header">
        <div>
          <h2>Outils du REPL</h2>
          <p className="axe-repl__muted">
            L'agent n'a qu'un outil, <code>python(code)</code>. Chaque module et chaque fonction ci-dessous
            peut être désactivé (ni importé, ni décrit au modèle) et sa description réécrite.
          </p>
        </div>
        <button type="button" className="axe-repl__save" disabled={!dirty} onClick={() => void save()}>
          Enregistrer
        </button>
      </header>
      {status ? <p className="axe-repl__status">{status}</p> : null}

      <section className="axe-repl__card">
        <label className="axe-repl__row">
          <input
            type="checkbox"
            checked={settings.agentEnabled}
            onChange={(e) => update((d) => { d.agentEnabled = e.target.checked; })}
          />
          <span>Faire tourner le chat avec l'agent REPL (service d'arrière-plan)</span>
        </label>
        <label className="axe-repl__row">
          <span>Compactage automatique à</span>
          <input
            type="range"
            min={50}
            max={100}
            step={5}
            value={settings.compactionThreshold}
            onChange={(e) => update((d) => { d.compactionThreshold = Number(e.target.value); })}
          />
          <strong>{settings.compactionThreshold >= 100 ? "désactivée" : `${settings.compactionThreshold} %`}</strong>
          <span className="axe-repl__muted">de la fenêtre de contexte</span>
        </label>
        <label className="axe-repl__row">
          <span>Sortie renvoyée au modèle par exécution</span>
          <input
            type="number"
            min={1000}
            step={1000}
            value={settings.outputCapChars}
            onChange={(e) => update((d) => { d.outputCapChars = Number(e.target.value) || 20000; })}
          />
          <span className="axe-repl__muted">caractères</span>
        </label>
      </section>

      {/* axe:sub-m — modèle par défaut des sous-agents */}
      <section className="axe-repl__card">
        <h3>Sous-agents</h3>
        <label className="axe-repl__row">
          <span>Modèle par défaut des sous-agents</span>
          <select
            value={settings.subagentDefaultModel ?? ""}
            onChange={(e) => update((d) => { d.subagentDefaultModel = e.target.value || null; })}
          >
            <option value="">Celui de la session parente</option>
            {settings.subagentDefaultModel && !modelChoices.some((m) => m.value === settings.subagentDefaultModel) ? (
              <option value={settings.subagentDefaultModel}>{settings.subagentDefaultModel}</option>
            ) : null}
            {modelChoices.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <p className="axe-repl__muted">
          Utilisé par <code>rlm.spawn</code> quand ni <code>model</code> ni le profil n'en donnent un.
        </p>
      </section>

      <section className="axe-repl__card">
        <h3>Plafond de sortie par modèle (max_tokens)</h3>
        <p className="axe-repl__muted">
          Clé <code>fournisseur/modèle</code>. Sans valeur, le maximum annoncé par le modèle est utilisé.
        </p>
        {Object.entries(settings.maxOutputTokens).map(([key, value]) => (
          <div className="axe-repl__row" key={key}>
            <code className="axe-repl__key">{key}</code>
            <input
              type="number"
              min={256}
              step={1024}
              value={value}
              onChange={(e) => update((d) => { d.maxOutputTokens[key] = Number(e.target.value) || 0; })}
            />
            <button type="button" onClick={() => update((d) => { delete d.maxOutputTokens[key]; })}>
              Retirer
            </button>
          </div>
        ))}
        <div className="axe-repl__row">
          <input
            placeholder="anthropic/claude-opus-4-1"
            value={newModelKey}
            onChange={(e) => setNewModelKey(e.target.value)}
          />
          <button
            type="button"
            disabled={!newModelKey.includes("/")}
            onClick={() => {
              update((d) => { d.maxOutputTokens[newModelKey.trim()] = 64000; });
              setNewModelKey("");
            }}
          >
            Ajouter
          </button>
        </div>
      </section>

      <ReplServicesSection workspacePath={workspacePath} /> {/* axe:cleanup */}

      <section className="axe-repl__card">
        <h3>
          Modules <span className="axe-repl__muted">{catalog ? `${enabledCount}/${catalog.length} actifs` : ""}</span>
        </h3>
        {catalogError ? <p className="axe-repl__error">Catalogue indisponible : {catalogError}</p> : null}
        {!catalog && !catalogError ? <p className="axe-repl__muted">Lecture du catalogue du kernel…</p> : null}
        <ul className="axe-repl__modules">
          {(catalog ?? []).map((module) => {
            const conf = moduleSetting(module.name);
            const expanded = open === module.name;
            const defaultDoc = firstParagraph(module.default_doc ?? module.doc);
            return (
              <li key={module.name} className="axe-repl__module" data-disabled={conf.enabled ? "false" : "true"}>
                <div className="axe-repl__row">
                  <input
                    type="checkbox"
                    checked={conf.enabled}
                    onChange={(e) => editModule(module.name, (m) => { m.enabled = e.target.checked; })}
                    aria-label={`Activer ${module.name}`}
                  />
                  <button type="button" className="axe-repl__module-name" onClick={() => setOpen(expanded ? null : module.name)}>
                    {expanded ? "▾" : "▸"} <code>{module.name}</code>
                  </button>
                  <span className="axe-repl__muted axe-repl__ellipsis">{firstParagraph(conf.description || defaultDoc)}</span>
                </div>
                {expanded ? (
                  <div className="axe-repl__module-body">
                    <textarea
                      rows={3}
                      placeholder={defaultDoc}
                      value={conf.description ?? ""}
                      onChange={(e) => editModule(module.name, (m) => { m.description = e.target.value || null; })}
                    />
                    <ul className="axe-repl__functions">
                      {module.functions.map((fn) => {
                        const fconf = conf.functions[fn.name] ?? { enabled: true };
                        const fnDefault = (fn.default_doc ?? fn.doc ?? "").split("\n")[0];
                        return (
                          <li key={fn.name}>
                            <div className="axe-repl__row">
                              <input
                                type="checkbox"
                                checked={fconf.enabled !== false}
                                disabled={!conf.enabled}
                                onChange={(e) =>
                                  editModule(module.name, (m) => {
                                    m.functions[fn.name] = { ...(m.functions[fn.name] ?? { enabled: true }), enabled: e.target.checked };
                                  })
                                }
                              />
                              <code className="axe-repl__ellipsis">{`${module.name}.${fn.signature}`}</code>
                            </div>
                            <input
                              className="axe-repl__fn-doc"
                              placeholder={fnDefault}
                              value={fconf.description ?? ""}
                              disabled={!conf.enabled}
                              onChange={(e) =>
                                editModule(module.name, (m) => {
                                  m.functions[fn.name] = {
                                    ...(m.functions[fn.name] ?? { enabled: true }),
                                    description: e.target.value || null,
                                  };
                                })
                              }
                            />
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

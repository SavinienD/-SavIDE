// axe:providers — Settings > Providers: configurable provider instances.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "@iconify/react";
import {
  KIND_ICONS,
  PROVIDERS_CHANGED_EVENT,
  providerApi,
  type ModelDefinition,
  type ModelOverride,
  type ProviderConfig,
  type ProviderInstance,
  type ProviderKind,
  type ProviderKindInfo,
  type ProviderSettingsView,
} from "./providers";

type Draft = ProviderConfig & { apiKey: string; hasApiKey: boolean; installed: boolean; isNew: boolean };

function toDraft(p: ProviderInstance): Draft {
  return { ...p, models: p.models.map((m) => ({ ...m })), apiKey: "", isNew: false };
}

function emptyModel(id: string): ModelDefinition {
  return {
    id,
    label: "",
    contextWindow: 128000,
    maxOutputTokens: 16384,
    supportsTools: true,
    supportsReasoning: false,
    supportsVision: false,
  };
}

export function CustomProvidersPanel() {
  const [view, setView] = useState<ProviderSettingsView | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [overrides, setOverrides] = useState<Record<string, ModelOverride>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addKind, setAddKind] = useState<ProviderKind>("open_ai_compatible");

  const apply = useCallback((next: ProviderSettingsView) => {
    setView(next);
    setDrafts(next.providers.map(toDraft));
    setOverrides(next.modelOverrides ?? {});
  }, []);

  const load = useCallback(async () => {
    try {
      apply(await providerApi.get());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [apply]);

  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener(PROVIDERS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(PROVIDERS_CHANGED_EVENT, refresh);
  }, [load]);

  const kinds = view?.kinds ?? [];
  const kindInfo = useCallback(
    (kind: ProviderKind): ProviderKindInfo | undefined => kinds.find((k) => k.kind === kind),
    [kinds],
  );
  const addableKinds = useMemo(
    () => kinds.filter((k) => !k.builtinId || !drafts.some((d) => d.id === k.builtinId)),
    [kinds, drafts],
  );

  const update = (key: string, patch: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => ((d.id || d.name) === key ? { ...d, ...patch } : d)));

  const addProvider = () => {
    const info = kindInfo(addKind);
    if (!info) return;
    const id = info.builtinId ?? "";
    const name = info.builtinId ? info.label : `${info.label} ${drafts.filter((d) => d.kind === addKind).length + 1}`;
    const draft: Draft = {
      id,
      name,
      kind: addKind,
      baseUrl: info.defaultBaseUrl,
      enabled: true,
      models: (info.defaultModels ?? []).map((m) => ({ ...m })),
      apiKey: "",
      hasApiKey: false,
      installed: false,
      isNew: true,
    };
    setDrafts((prev) => [...prev, draft]);
    setOpenId(id || name);
  };

  const save = async (nextDrafts = drafts) => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const apiKeys: Record<string, string> = {};
      const providers: ProviderConfig[] = nextDrafts.map((d) => {
        if (d.apiKey.trim() && d.id) apiKeys[d.id] = d.apiKey.trim();
        return { id: d.id, name: d.name, kind: d.kind, baseUrl: d.baseUrl, enabled: d.enabled, models: d.models };
      });
      // New custom instances get their id server-side; send keys in a second pass.
      let next = await providerApi.save(providers, apiKeys, overrides);
      const pending = nextDrafts.filter((d) => !d.id && d.apiKey.trim());
      if (pending.length) {
        const keyed: Record<string, string> = {};
        for (const d of pending) {
          const saved = next.providers.find((p) => p.name === d.name.trim() && p.kind === d.kind);
          if (saved) keyed[saved.id] = d.apiKey.trim();
        }
        next = await providerApi.save(next.providers, keyed, next.modelOverrides);
      }
      apply(next);
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
      setStatus("Enregistré");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = (d: Draft) => {
    const next = drafts.filter((x) => x !== d);
    setDrafts(next);
    if (!d.isNew) void save(next);
  };

  const clearKey = (d: Draft) => {
    if (!d.id) return;
    setBusy(true);
    providerApi
      .save(drafts.map(({ apiKey: _k, hasApiKey: _h, installed: _i, isNew: _n, ...c }) => c), { [d.id]: "" }, overrides)
      .then(apply)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const discover = async (d: Draft) => {
    setBusy(true);
    setError(null);
    try {
      const found = await providerApi.discover(d.kind, d.baseUrl, d.apiKey, d.id || undefined);
      const known = new Map(d.models.map((m) => [m.id, m]));
      const merged = found.map((m) => known.get(m.id) ?? m);
      for (const m of d.models) if (!found.some((f) => f.id === m.id)) merged.push(m);
      update(d.id || d.name, { models: merged });
      setStatus(`${found.length} modèle(s) découvert(s)`);
    } catch (err) {
      setError(`Découverte impossible : ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const detectLocal = async () => {
    setBusy(true);
    setError(null);
    try {
      const probes = await providerApi.detectLocal();
      const found = probes.filter((p) => p.available);
      setStatus(
        found.length
          ? found.map((p) => `${kindInfo(p.kind)?.label ?? p.kind} : ${p.models.length} modèle(s)`).join(" · ")
          : "Aucun serveur local détecté (Ollama :11434, LM Studio :1234)",
      );
      await load();
      window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const setModel = (d: Draft, index: number, patch: Partial<ModelDefinition>) =>
    update(d.id || d.name, { models: d.models.map((m, i) => (i === index ? { ...m, ...patch } : m)) });

  const setOverride = (providerId: string, modelId: string, contextWindow: number | undefined) => {
    const key = `${providerId}:${modelId}`;
    setOverrides((prev) => {
      const next = { ...prev };
      if (contextWindow && contextWindow > 0) next[key] = { ...next[key], contextWindow };
      else if (next[key]) {
        const { contextWindow: _c, ...rest } = next[key];
        if (rest.maxOutputTokens) next[key] = rest;
        else delete next[key];
      }
      return next;
    });
  };

  return (
    <section className="axe-providers">
      <header className="axe-providers__header">
        <div>
          <h2>Fournisseurs configurables</h2>
          <p>
            Points d'accès compatibles OpenAI ou Anthropic, Mistral, DeepSeek, xAI, Groq, Prime Inference et serveurs
            locaux (Ollama, LM Studio). Les clés restent côté application et ne sont jamais réaffichées.
          </p>
        </div>
        <div className="axe-providers__actions">
          {status && <span className="settings-pane__status" data-tone="ok">{status}</span>}
          <button type="button" className="settings-pane__btn" disabled={busy} onClick={() => void detectLocal()}>
            <Icon icon="solar:radar-linear" width={13} height={13} />
            <span>Détecter local</span>
          </button>
          <select
            className="axe-providers__select"
            value={addKind}
            onChange={(e) => setAddKind(e.target.value as ProviderKind)}
          >
            {addableKinds.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
          <button type="button" className="settings-pane__btn" disabled={busy || !addableKinds.length} onClick={addProvider}>
            <Icon icon="solar:add-circle-linear" width={13} height={13} />
            <span>Ajouter</span>
          </button>
        </div>
      </header>
      {error && <div className="settings-pane__provider-error">{error}</div>}

      {drafts.length === 0 && <p className="axe-providers__empty">Aucun fournisseur configurable.</p>}

      {drafts.map((d) => {
        const key = d.id || d.name;
        const info = kindInfo(d.kind);
        const open = openId === key;
        const tone = !d.enabled ? "off" : d.installed ? "ok" : "error";
        const label = !d.enabled
          ? "Désactivé"
          : d.installed
            ? "Actif"
            : !d.models.length
              ? "Aucun modèle"
              : !d.baseUrl.trim()
                ? "URL manquante"
                : !d.hasApiKey && !d.apiKey && !info?.local
                  ? "Clé manquante"
                  : "Non chargé (voir le journal)";
        return (
          <div key={key} className="axe-providers__card" data-open={open ? "true" : "false"}>
            <button type="button" className="axe-providers__row" onClick={() => setOpenId(open ? null : key)}>
              <Icon icon={KIND_ICONS[d.kind]} width={18} height={18} />
              <span className="axe-providers__name">{d.name || info?.label}</span>
              <span className="axe-providers__kind">{info?.label}</span>
              <span className="settings-pane__chip" data-tone={tone}>
                <span className="settings-pane__chip-dot" />
                {label}
              </span>
              <span className="axe-providers__count">{d.models.length} modèle(s)</span>
              <Icon icon={open ? "solar:alt-arrow-up-linear" : "solar:alt-arrow-down-linear"} width={12} height={12} />
            </button>
            {open && (
              <div className="axe-providers__body">
                <div className="axe-providers__grid">
                  <label>
                    Nom
                    <input value={d.name} disabled={Boolean(info?.builtinId)} onChange={(e) => update(key, { name: e.target.value })} />
                  </label>
                  <label>
                    URL de base
                    <input value={d.baseUrl} placeholder={info?.defaultBaseUrl || "https://…/v1"} onChange={(e) => update(key, { baseUrl: e.target.value })} />
                  </label>
                  {!info?.local && (
                    <label>
                      Clé API {d.hasApiKey && <em>(enregistrée)</em>}
                      <input
                        type="password"
                        value={d.apiKey}
                        placeholder={d.hasApiKey ? "•••••••• (laisser vide pour conserver)" : "sk-…"}
                        onChange={(e) => update(key, { apiKey: e.target.value })}
                      />
                    </label>
                  )}
                  <label className="axe-providers__check">
                    <input type="checkbox" checked={d.enabled} onChange={(e) => update(key, { enabled: e.target.checked })} />
                    Activé
                  </label>
                </div>

                <div className="axe-providers__models-head">
                  <strong>Modèles</strong>
                  <button type="button" className="settings-pane__btn" disabled={busy} onClick={() => void discover(d)}>
                    <Icon icon="solar:refresh-linear" width={13} height={13} />
                    <span>Découvrir (GET /models)</span>
                  </button>
                  <button
                    type="button"
                    className="settings-pane__btn"
                    onClick={() => {
                      const id = window.prompt("Identifiant du modèle");
                      if (id?.trim()) update(key, { models: [...d.models, emptyModel(id.trim())] });
                    }}
                  >
                    <Icon icon="solar:add-circle-linear" width={13} height={13} />
                    <span>Saisir</span>
                  </button>
                </div>
                {d.models.length > 0 && (
                  <table className="axe-providers__models">
                    <thead>
                      <tr>
                        <th>Modèle</th>
                        <th title="Fenêtre de contexte déclarée">Contexte</th>
                        <th title="Contexte imposé (modelOverrides.<id>.contextWindow)">Imposé</th>
                        <th>Sortie max</th>
                        <th>Outils</th>
                        <th>Raison.</th>
                        <th>Vision</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {d.models.map((m, i) => (
                        <tr key={m.id}>
                          <td title={m.id}>
                            <input value={m.label} placeholder={m.id} onChange={(e) => setModel(d, i, { label: e.target.value })} />
                          </td>
                          <td>
                            <input type="number" min={1} value={m.contextWindow} onChange={(e) => setModel(d, i, { contextWindow: Number(e.target.value) || 1 })} />
                          </td>
                          <td>
                            <input
                              type="number"
                              min={0}
                              placeholder="—"
                              value={overrides[`${d.id}:${m.id}`]?.contextWindow ?? ""}
                              disabled={!d.id}
                              onChange={(e) => setOverride(d.id, m.id, Number(e.target.value) || undefined)}
                            />
                          </td>
                          <td>
                            <input type="number" min={1} value={m.maxOutputTokens} onChange={(e) => setModel(d, i, { maxOutputTokens: Number(e.target.value) || 1 })} />
                          </td>
                          <td><input type="checkbox" checked={m.supportsTools} onChange={(e) => setModel(d, i, { supportsTools: e.target.checked })} /></td>
                          <td><input type="checkbox" checked={m.supportsReasoning} onChange={(e) => setModel(d, i, { supportsReasoning: e.target.checked })} /></td>
                          <td><input type="checkbox" checked={m.supportsVision} onChange={(e) => setModel(d, i, { supportsVision: e.target.checked })} /></td>
                          <td>
                            <button type="button" className="axe-providers__icon-btn" title="Retirer" onClick={() => update(key, { models: d.models.filter((_, j) => j !== i) })}>
                              <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="axe-providers__footer">
                  <button type="button" className="settings-pane__btn" disabled={busy} onClick={() => remove(d)}>
                    <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                    <span>Supprimer</span>
                  </button>
                  {d.hasApiKey && (
                    <button type="button" className="settings-pane__btn" disabled={busy} onClick={() => clearKey(d)}>
                      <span>Oublier la clé</span>
                    </button>
                  )}
                  <button type="button" className="settings-pane__btn settings-pane__btn--primary" disabled={busy} onClick={() => void save()}>
                    <Icon icon="solar:diskette-linear" width={13} height={13} />
                    <span>{busy ? "…" : "Enregistrer"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

// providers — Settings > Providers: configurable provider instances.
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
// fournisseurs-178 — identifiant réel modifiable, validation, fusion de « Découvrir ».
import {
  deplacerSurcharge,
  erreurNouvelIdentifiant,
  erreursIdentifiants,
  filtrerDecouverte,
  fusionnerDecouverte,
  identifiantsNettoyes,
  modificationsEnCours,
  retirerRangs,
  modelesInvalides,
  renommerModele,
  fenetreParDefaut,
  fournisseurLocal,
  sortieParDefaut,
} from "./modelesFournisseur";

type Draft = ProviderConfig & { apiKey: string; hasApiKey: boolean; installed: boolean; isNew: boolean };

function toDraft(p: ProviderInstance): Draft {
  return { ...p, models: p.models.map((m) => ({ ...m })), apiKey: "", isNew: false };
}

/** fournisseurs-178 — exemple d'identifiant exact, par type de fournisseur. */
const EXEMPLE_ID: Partial<Record<ProviderKind, string>> = {
  ollama: "qwen3:8b",
  lm_studio: "qwen/qwen3-8b",
  mistral: "mistral-large-latest",
  deep_seek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
};

const MESSAGE_IDENTIFIANTS = "Identifiants de modèles à corriger (vides ou en double) avant d'enregistrer.";

/** fenetre-locale — modèle saisi à la main : 32 768 jetons pour un serveur local (Ollama réserve
 *  la mémoire de toute la fenêtre), 128 000 pour le cloud ; modifiable dans le tableau. */
function emptyModel(id: string, contextWindow: number, local: boolean): ModelDefinition {
  return {
    id,
    label: "",
    contextWindow,
    maxOutputTokens: local ? sortieParDefaut(contextWindow) : 16384,
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
  // fournisseurs-178 — « Saisir » : identifiant tapé dans la carte `cle`.
  const [saisie, setSaisie] = useState<{ cle: string; id: string; erreur: string | null } | null>(null);
  const invalides = modelesInvalides(drafts);
  // début d'identifiant pour « Découvrir » (par carte), modèles cochés.
  const [filtres, setFiltres] = useState<Record<string, string>>({});
  const [coches, setCoches] = useState<{ cle: string; rangs: Set<number> } | null>(null);
  const modifie = useMemo(
    () => (view ? modificationsEnCours(drafts, view.providers.map(toDraft), overrides, view.modelOverrides) : false),
    [drafts, overrides, view],
  );

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
    if (modelesInvalides(nextDrafts)) {
      setStatus(null);
      setError(MESSAGE_IDENTIFIANTS);
      return;
    }
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const apiKeys: Record<string, string> = {};
      const providers: ProviderConfig[] = nextDrafts.map((d) => {
        if (d.apiKey.trim() && d.id) apiKeys[d.id] = d.apiKey.trim();
        return { id: d.id, name: d.name, kind: d.kind, baseUrl: d.baseUrl, enabled: d.enabled, models: identifiantsNettoyes(d.models) };
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

  // « Annuler les modifications » (ou Échap) : retour à l'état enregistré, sans rien enregistrer.
  const annuler = useCallback(() => {
    if (!view) return;
    apply(view);
    setSaisie(null);
    setCoches(null);
    setError(null);
    setStatus("Modifications annulées");
  }, [apply, view]);

  useEffect(() => {
    if (!modifie) return;
    const touche = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Échap dans « Saisir » ferme seulement la saisie.
      if ((e.target as HTMLElement | null)?.closest?.(".axe-providers__saisie")) return;
      e.preventDefault();
      annuler();
    };
    document.addEventListener("keydown", touche);
    return () => document.removeEventListener("keydown", touche);
  }, [modifie, annuler]);

  const cocher = (cle: string, rang: number, oui: boolean) =>
    setCoches((prev) => {
      const rangs = new Set(prev?.cle === cle ? prev.rangs : []);
      if (oui) rangs.add(rang);
      else rangs.delete(rang);
      return rangs.size ? { cle, rangs } : null;
    });

  const retirerSelection = (d: Draft) => {
    const cle = d.id || d.name;
    if (coches?.cle !== cle) return;
    update(cle, { models: retirerRangs(d.models, coches.rangs) });
    setStatus(`${coches.rangs.size} modèle(s) retiré(s) — « Enregistrer » pour garder, « Annuler les modifications » pour revenir`);
    setCoches(null);
  };

  const remove = (d: Draft) => {
    const next = drafts.filter((x) => x !== d);
    setDrafts(next);
    if (!d.isNew) void save(next);
  };

  const clearKey = (d: Draft) => {
    if (!d.id) return;
    if (invalides) {
      setError(MESSAGE_IDENTIFIANTS);
      return;
    }
    setBusy(true);
    providerApi
      .save(
        drafts.map(({ apiKey: _k, hasApiKey: _h, installed: _i, isNew: _n, ...c }) => ({ ...c, models: identifiantsNettoyes(c.models) })),
        { [d.id]: "" },
        overrides,
      )
      .then(apply)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const discover = async (d: Draft) => {
    setBusy(true);
    setError(null);
    try {
      const cle = d.id || d.name;
      const tous = await providerApi.discover(d.kind, d.baseUrl, d.apiKey, d.id || undefined);
      // début d'identifiant tapé (filtre, sinon « Saisir ») : seulement ceux-là.
      const debut = (filtres[cle] ?? "").trim() || (saisie?.cle === cle ? saisie.id.trim() : "");
      const found = filtrerDecouverte(tous, debut);
      // Identifiants réels du serveur ; les modèles déjà déclarés gardent leurs réglages.
      update(cle, { models: fusionnerDecouverte(d.models, found) });
      setCoches(null);
      setStatus(
        debut
          ? `${found.length} modèle(s) découvert(s) commençant par « ${debut} » (sur ${tous.length})`
          : `${found.length} modèle(s) découvert(s)`,
      );
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

  // fournisseurs-178 — l'identifiant est ce qui part au fournisseur : le changer change le
  // modèle appelé (le contexte imposé suit le modèle).
  const renommer = (d: Draft, index: number, id: string) => {
    const ancien = (d.models[index]?.id ?? "").trim();
    // Une autre ligne porte le même identifiant (doublon en cours de frappe) : la surcharge est la sienne.
    const partage = d.models.some((m, j) => j !== index && m.id.trim() === ancien);
    update(d.id || d.name, { models: renommerModele(d.models, index, id) });
    if (d.id && !partage) setOverrides((prev) => deplacerSurcharge(prev, d.id, ancien, id.trim()));
  };

  const ajouterSaisie = (d: Draft) => {
    if (!saisie) return;
    const erreur = erreurNouvelIdentifiant(d.models, saisie.id);
    if (erreur) {
      setSaisie({ ...saisie, erreur });
      return;
    }
    const id = saisie.id.trim();
    const cle = d.id || d.name;
    // fenetre-locale — local : 32 768 tout de suite ; Ollama peut annoncer moins (/api/show,
    // lu par le Rust) : la ligne est alors corrigée, sauf si la valeur a déjà été changée à la main.
    const local = fournisseurLocal(d.kind, Boolean(kindInfo(d.kind)?.local), d.baseUrl);
    const fenetre = fenetreParDefaut(local);
    const sortie = local ? sortieParDefaut(fenetre) : 16384;
    update(cle, { models: [...d.models, emptyModel(id, fenetre, local)] });
    setSaisie(null);
    void providerApi
      .defaultWindow(d.kind, d.baseUrl, id)
      .then((annoncee) => {
        if (typeof annoncee !== "number" || annoncee <= 0 || annoncee === fenetre) return;
        setDrafts((prev) =>
          prev.map((x) =>
            (x.id || x.name) !== cle
              ? x
              : {
                  ...x,
                  models: x.models.map((m) =>
                    m.id.trim() === id && m.contextWindow === fenetre
                      ? {
                          ...m,
                          contextWindow: annoncee,
                          maxOutputTokens: m.maxOutputTokens === sortie && local ? sortieParDefaut(annoncee) : Math.min(m.maxOutputTokens, annoncee),
                        }
                      : m,
                  ),
                },
          ),
        );
      })
      .catch(() => undefined);
  };

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
        const erreurs = erreursIdentifiants(d.models);
        const premiereErreur = Object.values(erreurs)[0];
        const local = fournisseurLocal(d.kind, Boolean(info?.local), d.baseUrl);
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
                    <span className="axe-providers__champ-titre">Nom</span>
                    <input value={d.name} disabled={Boolean(info?.builtinId)} onChange={(e) => update(key, { name: e.target.value })} />
                  </label>
                  <label>
                    <span className="axe-providers__champ-titre">URL de base</span>
                    <input value={d.baseUrl} placeholder={info?.defaultBaseUrl || "https://…/v1"} onChange={(e) => update(key, { baseUrl: e.target.value })} />
                  </label>
                  {!info?.local && (
                    <label>
                      <span className="axe-providers__champ-titre">Clé API {d.hasApiKey && <em>(enregistrée)</em>}</span>
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
                  <button
                    type="button"
                    className="settings-pane__btn"
                    data-action="decouvrir-modeles"
                    title="Découvrir les modèles du serveur (GET /models) : identifiants réels"
                    disabled={busy}
                    onClick={() => void discover(d)}
                  >
                    <Icon icon="solar:refresh-linear" width={13} height={13} />
                    <span>Découvrir (GET /models)</span>
                  </button>
                  <input
                    className="axe-providers__filtre"
                    data-champ="filtre-decouverte"
                    value={filtres[key] ?? ""}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="Début de l'identifiant (facultatif)"
                    title="« Découvrir » n'ajoute que les modèles dont l'identifiant commence ainsi"
                    aria-label="Début de l'identifiant des modèles à découvrir"
                    onChange={(e) => setFiltres((prev) => ({ ...prev, [key]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void discover(d);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="settings-pane__btn"
                    data-action="saisir-modele"
                    title="Ajouter un modèle par son identifiant exact"
                    onClick={() => setSaisie({ cle: key, id: "", erreur: null })}
                  >
                    <Icon icon="solar:add-circle-linear" width={13} height={13} />
                    <span>Saisir</span>
                  </button>
                  {coches?.cle === key && (
                    <button
                      type="button"
                      className="settings-pane__btn"
                      data-action="retirer-selection"
                      title="Retirer les modèles cochés"
                      onClick={() => retirerSelection(d)}
                    >
                      <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                      <span>Retirer la sélection ({coches.rangs.size})</span>
                    </button>
                  )}
                </div>
                {saisie?.cle === key && (
                  <form
                    className="axe-providers__saisie"
                    onSubmit={(e) => {
                      e.preventDefault();
                      ajouterSaisie(d);
                    }}
                  >
                    <label>
                      <span className="axe-providers__saisie-titre" title="Identifiant exact du modèle">Identifiant exact du modèle</span>
                      <input
                        autoFocus
                        data-champ="nouvel-id"
                        value={saisie.id}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={EXEMPLE_ID[d.kind] ?? "identifiant-du-modele"}
                        aria-invalid={saisie.erreur ? true : undefined}
                        onChange={(e) => setSaisie({ ...saisie, id: e.target.value, erreur: null })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") setSaisie(null);
                        }}
                      />
                    </label>
                    <button type="submit" className="settings-pane__btn settings-pane__btn--primary" data-action="ajouter-modele">
                      <span>Ajouter</span>
                    </button>
                    <button type="button" className="settings-pane__btn" onClick={() => setSaisie(null)}>
                      <span>Annuler</span>
                    </button>
                    <span className="axe-providers__hint">
                      {saisie.erreur ? (
                        <span className="axe-providers__model-error" data-erreur="saisie">{saisie.erreur}</span>
                      ) : (
                        "Le nom exact connu du fournisseur (pour Ollama : celui de « ollama list »)."
                      )}
                    </span>
                  </form>
                )}
                {d.models.length > 0 && (
                  <div className="axe-providers__models-wrap">
                  <table className="axe-providers__models">
                    <thead>
                      <tr>
                        <th className="axe-providers__col-choix">
                          <label className="axe-providers__case" title="Tout cocher">
                            <input
                              type="checkbox"
                              data-champ="choisir-tout"
                              checked={coches?.cle === key && coches.rangs.size === d.models.length}
                              onChange={(e) => setCoches(e.target.checked ? { cle: key, rangs: new Set(d.models.map((_, i) => i)) } : null)}
                            />
                          </label>
                        </th>
                        <th title="Nom exact envoyé au fournisseur (ex. qwen3:8b pour Ollama)">Identifiant</th>
                        <th title="Libellé de la liste des modèles (vide = identifiant)">Nom affiché</th>
                        <th
                          title={
                            local
                              ? "Fenêtre de contexte déclarée. Serveur local : 32 768 par défaut, car Ollama réserve la mémoire de toute la fenêtre."
                              : "Fenêtre de contexte déclarée"
                          }
                        >
                          Contexte
                        </th>
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
                        // Clé = rang : la clé ne doit pas changer pendant la frappe de l'identifiant.
                        <tr key={i} data-erreur={erreurs[i] ? "true" : undefined}>
                          <td data-label="" className="axe-providers__col-choix">
                            <label className="axe-providers__case" title="Cocher pour retirer plusieurs modèles">
                              <input
                                type="checkbox"
                                data-champ="choisir"
                                checked={coches?.cle === key && coches.rangs.has(i)}
                                onChange={(e) => cocher(key, i, e.target.checked)}
                              />
                            </label>
                          </td>
                          <td data-label="Identifiant">
                            <input
                              className="axe-providers__model-id"
                              data-champ="id"
                              value={m.id}
                              spellCheck={false}
                              autoComplete="off"
                              placeholder="identifiant exact"
                              aria-invalid={erreurs[i] ? true : undefined}
                              title={erreurs[i] ?? "Identifiant exact envoyé au fournisseur"}
                              onChange={(e) => renommer(d, i, e.target.value)}
                            />
                          </td>
                          <td data-label="Nom affiché">
                            <input
                              data-champ="label"
                              value={m.label}
                              placeholder={m.id.trim() || "nom affiché"}
                              title="Nom affiché dans la liste des modèles (vide = identifiant)"
                              onChange={(e) => setModel(d, i, { label: e.target.value })}
                            />
                          </td>
                          <td data-label="Contexte">
                            <input
                              type="number"
                              min={1}
                              data-champ="contexte"
                              value={m.contextWindow}
                              title={local ? "Jetons de contexte : Ollama réserve la mémoire de toute la fenêtre" : undefined}
                              onChange={(e) => setModel(d, i, { contextWindow: Number(e.target.value) || 1 })}
                            />
                          </td>
                          <td data-label="Imposé">
                            <input
                              type="number"
                              min={0}
                              placeholder="—"
                              value={overrides[`${d.id}:${m.id.trim()}`]?.contextWindow ?? ""}
                              disabled={!d.id || !m.id.trim()}
                              onChange={(e) => setOverride(d.id, m.id.trim(), Number(e.target.value) || undefined)}
                            />
                          </td>
                          <td data-label="Sortie max">
                            <input type="number" min={1} value={m.maxOutputTokens} onChange={(e) => setModel(d, i, { maxOutputTokens: Number(e.target.value) || 1 })} />
                          </td>
                          <td data-label="Outils">
                            <label className="axe-providers__case" title="Outils (appels de fonctions)">
                              <input type="checkbox" checked={m.supportsTools} onChange={(e) => setModel(d, i, { supportsTools: e.target.checked })} />
                            </label>
                          </td>
                          <td data-label="Raison.">
                            <label className="axe-providers__case" title="Raisonnement">
                              <input type="checkbox" checked={m.supportsReasoning} onChange={(e) => setModel(d, i, { supportsReasoning: e.target.checked })} />
                            </label>
                          </td>
                          <td data-label="Vision">
                            <label className="axe-providers__case" title="Vision (images)">
                              <input type="checkbox" checked={m.supportsVision} onChange={(e) => setModel(d, i, { supportsVision: e.target.checked })} />
                            </label>
                          </td>
                          <td data-label="">
                            <button type="button" className="axe-providers__icon-btn" title="Retirer" onClick={() => {
                              update(key, { models: d.models.filter((_, j) => j !== i) });
                              setCoches(null);
                            }}>
                              <Icon icon="solar:trash-bin-minimalistic-linear" width={13} height={13} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                )}
                {premiereErreur && (
                  <div className="axe-providers__model-error" data-erreur="modeles">
                    {premiereErreur}
                  </div>
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
                  <button
                    type="button"
                    className="settings-pane__btn"
                    data-action="annuler-modifications"
                    disabled={busy || !modifie}
                    title="Annuler les modifications : revenir à l'état enregistré, sans enregistrer (Échap)"
                    aria-label="Annuler les modifications"
                    onClick={annuler}
                  >
                    <Icon icon="solar:undo-left-round-linear" width={13} height={13} />
                    <span>Annuler</span>
                  </button>
                  <button
                    type="button"
                    className="settings-pane__btn settings-pane__btn--primary"
                    data-action="enregistrer-fournisseurs"
                    disabled={busy || invalides}
                    title={invalides ? MESSAGE_IDENTIFIANTS : undefined}
                    onClick={() => void save()}
                  >
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

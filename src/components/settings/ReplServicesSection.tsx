import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import type { ImageProvider, ToolSettings, WebSearchProvider } from "../../types";
import { ApiKeyField } from "./ApiKeyField";

// axe:cleanup — web search and image generation providers used by the REPL
// (`web.*`, `images.*`). Stored in the existing tool settings so keys entered
// before the Tools tab was removed are kept.

const CHANGED_EVENT = "axecode:tool-settings-changed";

export function ReplServicesSection({ workspacePath }: { workspacePath: string }) {
  const [settings, setSettings] = useState<ToolSettings | null>(null);
  const [saved, setSaved] = useState("");
  const [openAiConnected, setOpenAiConnected] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    void api
      .listToolSettings(workspacePath)
      .then((loaded) => {
        if (disposed) return;
        setSettings(loaded);
        setSaved(JSON.stringify(loaded));
      })
      .catch((e) => !disposed && setStatus(String(e)));
    void api
      .getOpenAiProviderStatus()
      .then((s) => !disposed && setOpenAiConnected(s.connected === true))
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [workspacePath]);

  const patch = useCallback((value: Partial<ToolSettings>) => {
    setSettings((current) => (current ? { ...current, ...value } : current));
  }, []);

  const save = useCallback(async () => {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const next = await api.saveToolSettings(workspacePath, settings);
      setSettings(next);
      setSaved(JSON.stringify(next));
      setStatus("Enregistré.");
      window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
    } catch (e) {
      setStatus(String(e));
    } finally {
      setSaving(false);
    }
  }, [settings, workspacePath]);

  if (!settings) {
    return <section className="axe-repl__card">{status ?? "Chargement…"}</section>;
  }

  const imageProvider: ImageProvider = settings.imageProvider ?? "gptImage2";
  const webSearchProvider: WebSearchProvider = settings.webSearchProvider ?? "classic";
  const subscriptionActive =
    imageProvider === "gptImage2" && openAiConnected && settings.openaiImageUseSubscription;
  const dirty = JSON.stringify(settings) !== saved;

  return (
    <section className="axe-repl__card axe-repl__services">
      <div className="axe-repl__services-head">
        <h3>Recherche web et images</h3>
        <div className="axe-repl__services-actions">
          {status ? <span className="axe-repl__muted">{status}</span> : null}
          <button type="button" className="axe-repl__save" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </div>

      <h4>Recherche web (web.search)</h4>
      <div className="settings-pane__tool-provider-switch" role="group" aria-label="Fournisseur de recherche web">
        <button
          type="button"
          data-active={webSearchProvider === "classic" ? "true" : "false"}
          onClick={() => patch({ webSearchProvider: "classic" })}
        >
          Classique
        </button>
        <button
          type="button"
          data-active={webSearchProvider === "linkup" ? "true" : "false"}
          onClick={() => patch({ webSearchProvider: "linkup" })}
        >
          LinkUp
        </button>
      </div>
      {webSearchProvider === "linkup" ? (
        <ApiKeyField
          label="Clé API LinkUp"
          value={settings.linkupApiKey ?? ""}
          placeholder="clé linkup"
          onChange={(linkupApiKey) => patch({ linkupApiKey })}
        />
      ) : null}

      <h4>Génération d'images (images.create)</h4>
      <div className="settings-pane__tool-provider-switch" role="group" aria-label="Fournisseur d'images">
        <button
          type="button"
          data-active={imageProvider === "gptImage2" ? "true" : "false"}
          onClick={() => patch({ imageProvider: "gptImage2" })}
        >
          GPT Image 2
        </button>
        <button
          type="button"
          data-active={imageProvider === "nanoBanana2" ? "true" : "false"}
          onClick={() => patch({ imageProvider: "nanoBanana2" })}
        >
          Nano Banana 2
        </button>
      </div>
      {imageProvider === "gptImage2" ? (
        <label className="axe-repl__check" data-disabled={openAiConnected ? "false" : "true"}>
          <input
            type="checkbox"
            checked={subscriptionActive}
            disabled={!openAiConnected}
            onChange={(e) => patch({ openaiImageUseSubscription: e.target.checked })}
          />
          Utiliser l'abonnement OpenAI
          <span className="axe-repl__muted">
            {openAiConnected
              ? " — authentifie les requêtes avec le compte OpenAI connecté."
              : " — connectez OpenAI dans Réglages > Fournisseurs."}
          </span>
        </label>
      ) : null}
      {imageProvider === "nanoBanana2" ? (
        <ApiKeyField
          label="Clé API Gemini (Nano Banana)"
          value={settings.nanoBananaApiKey ?? ""}
          placeholder="AIza…"
          onChange={(nanoBananaApiKey) => patch({ nanoBananaApiKey })}
        />
      ) : !subscriptionActive ? (
        <ApiKeyField
          label="Clé API OpenAI"
          value={settings.openaiImageApiKey ?? ""}
          placeholder="sk-..."
          onChange={(openaiImageApiKey) => patch({ openaiImageApiKey })}
        />
      ) : null}
    </section>
  );
}

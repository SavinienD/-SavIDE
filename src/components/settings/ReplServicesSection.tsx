import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import type { ImageProvider, MediaProviderConfig, ToolSettings, WebSearchProvider } from "../../types";
import { ApiKeyField } from "./ApiKeyField";
import { libelleImages, libelleRecherche, routeOpenAi } from "../../lib/outilsComptes";
import { apisDuType, erreurGabarit, nouvelleApi, PREREGLAGES_API } from "../../lib/apisMedias";
import "./repl-medias.css";

// cleanup — web search and image generation providers used by the REPL
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
  // « classic » (ancienne valeur par défaut) = Automatique.
  const brut = settings.webSearchProvider as string | undefined;
  const webSearchProvider: WebSearchProvider = brut === "linkup" || brut === "exa" ? brut : "auto";
  const cleOpenAi = settings.openaiImageApiKey ?? "";
  const routeRecherche = routeOpenAi({
    cle: cleOpenAi,
    connecte: openAiConnected,
    forcerAbonnement: settings.openaiImageUseSubscription,
  });
  const routeImages = routeOpenAi({
    cle: cleOpenAi,
    connecte: openAiConnected,
    forcerAbonnement: settings.openaiImageUseSubscription,
  });
  const apis = settings.mediaProviders ?? [];
  const apisImages = apisDuType(apis, "image");
  const apisVideos = apisDuType(apis, "video");
  const majApi = (index: number, valeur: Partial<MediaProviderConfig>) =>
    patch({ mediaProviders: apis.map((a, i) => (i === index ? { ...a, ...valeur } : a)) });
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
        {([
          ["auto", "Automatique"],
          ["exa", "Exa"],
          ["linkup", "LinkUp"],
        ] as const).map(([valeur, libelle]) => (
          <button
            key={valeur}
            type="button"
            data-fournisseur={valeur}
            data-active={webSearchProvider === valeur ? "true" : "false"}
            onClick={() => patch({ webSearchProvider: valeur })}
          >
            {libelle}
          </button>
        ))}
      </div>
      <p className="axe-repl__muted" data-regle="recherche" data-route={routeRecherche}>
        {libelleRecherche(webSearchProvider, routeRecherche)}
      </p>
      {webSearchProvider === "linkup" ? (
        <ApiKeyField
          label="Clé API LinkUp"
          value={settings.linkupApiKey ?? ""}
          placeholder="clé linkup"
          onChange={(linkupApiKey) => patch({ linkupApiKey })}
        />
      ) : null}

      <h4>Génération d'images (images.generate)</h4>
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
        {apisImages.length ? (
          <button
            type="button"
            data-fournisseur="custom"
            data-active={imageProvider === "custom" ? "true" : "false"}
            onClick={() => patch({ imageProvider: "custom" })}
          >
            API personnalisée
          </button>
        ) : null}
      </div>
      {imageProvider === "custom" ? (
        <label className="axe-medias__ligne">
          <span>API des images</span>
          <select
            value={settings.imageCustomProvider || apisImages[0]?.name || ""}
            onChange={(e) => patch({ imageCustomProvider: e.target.value })}
          >
            {apisImages.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {imageProvider === "gptImage2" ? (
        <p className="axe-repl__muted" data-regle="images" data-route={routeImages}>
          {libelleImages(routeImages)}
        </p>
      ) : null}
      {imageProvider === "nanoBanana2" ? (
        <ApiKeyField
          label="Clé API Gemini (Nano Banana)"
          value={settings.nanoBananaApiKey ?? ""}
          placeholder="AIza…"
          onChange={(nanoBananaApiKey) => patch({ nanoBananaApiKey })}
        />
      ) : null}

      <h4>Compte OpenAI des outils</h4>
      <p className="axe-repl__muted">
        Abonnement ChatGPT du compte connecté
        {openAiConnected ? " (connecté)" : " (non connecté : Réglages > Fournisseurs > OpenAI)"}, sinon la clé API OpenAI
        ci-dessous.
      </p>
      <ApiKeyField
        label="Clé API OpenAI (facultative)"
        value={cleOpenAi}
        placeholder="sk-..."
        onChange={(openaiImageApiKey) => patch({ openaiImageApiKey })}
      />
      {openAiConnected && cleOpenAi.trim() ? (
        <label className="axe-repl__check">
          <input
            type="checkbox"
            checked={settings.openaiImageUseSubscription}
            onChange={(e) => patch({ openaiImageUseSubscription: e.target.checked })}
          />
          Utiliser l'abonnement ChatGPT plutôt que la clé (recherche web et images)
        </label>
      ) : null}

      <h4>API personnalisées (images et vidéos)</h4>
      <p className="axe-repl__muted">
        Toute API HTTP de génération : images.generate(…, provider="nom") et videos.generate(…). Seule l'URL est
        obligatoire ; le média est trouvé dans la réponse (base64, URL ou fichier) et une tâche « en cours » est suivie
        jusqu'à la fin. La clé reste dans les réglages de l'appli ($NOM : lue dans la variable NOM).
      </p>
      {apisVideos.length ? (
        <label className="axe-medias__ligne">
          <span>Vidéos (videos.generate)</span>
          <select
            value={settings.videoProvider || apisVideos[0]?.name || ""}
            onChange={(e) => patch({ videoProvider: e.target.value })}
          >
            {apisVideos.map((a) => (
              <option key={a.name} value={a.name}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="axe-repl__muted" data-regle="videos">
          Aucune API vidéo : videos.generate dira d'en ajouter une.
        </p>
      )}
      {apis.map((api, index) => {
        const erreur = erreurGabarit(api.body);
        return (
          <div key={index} className="axe-medias__api" data-api={api.name} data-type={api.kind}>
            <div className="axe-medias__entete">
              <input
                aria-label="Nom de l'API"
                value={api.name}
                onChange={(e) => majApi(index, { name: e.target.value })}
              />
              <div className="settings-pane__tool-provider-switch" role="group" aria-label="Type de média">
                <button type="button" data-active={api.kind === "image" ? "true" : "false"} onClick={() => majApi(index, { kind: "image" })}>
                  Image
                </button>
                <button type="button" data-active={api.kind === "video" ? "true" : "false"} onClick={() => majApi(index, { kind: "video" })}>
                  Vidéo
                </button>
              </div>
              <button
                type="button"
                className="axe-medias__retirer"
                data-action="retirer-api"
                onClick={() => patch({ mediaProviders: apis.filter((_, i) => i !== index) })}
              >
                Retirer
              </button>
            </div>
            <label className="axe-medias__ligne">
              <span>URL (POST)</span>
              <input value={api.url} placeholder="https://…" onChange={(e) => majApi(index, { url: e.target.value })} />
            </label>
            <label className="axe-medias__ligne">
              <span>Modèle</span>
              <input value={api.model} placeholder="{model} dans l'URL ou le corps" onChange={(e) => majApi(index, { model: e.target.value })} />
            </label>
            <ApiKeyField
              label="Clé API (ou $VARIABLE)"
              value={api.apiKey}
              placeholder="clé"
              onChange={(apiKey) => majApi(index, { apiKey })}
            />
            <div className="axe-medias__duo">
              <label className="axe-medias__ligne">
                <span>En-tête</span>
                <input value={api.authHeader} placeholder="Authorization" onChange={(e) => majApi(index, { authHeader: e.target.value })} />
              </label>
              <label className="axe-medias__ligne">
                <span>Préfixe</span>
                <input value={api.authPrefix} placeholder="Bearer " onChange={(e) => majApi(index, { authPrefix: e.target.value })} />
              </label>
            </div>
            <label className="axe-medias__ligne axe-medias__ligne--haut">
              <span>Corps JSON</span>
              <textarea
                rows={2}
                value={api.body}
                placeholder='{"model": "{model}", "prompt": "{prompt}"}'
                onChange={(e) => majApi(index, { body: e.target.value })}
              />
            </label>
            {erreur ? <p className="axe-repl__error" data-erreur="gabarit">{erreur}</p> : null}
            <details className="axe-medias__avance">
              <summary>Suivi et résultat (facultatif)</summary>
              <label className="axe-medias__ligne">
                <span>URL de suivi</span>
                <input value={api.pollUrl} placeholder="auto (status_url, urls.get, {url}/{id})" onChange={(e) => majApi(index, { pollUrl: e.target.value })} />
              </label>
              <label className="axe-medias__ligne">
                <span>URL du résultat</span>
                <input value={api.resultUrl} placeholder="auto (response_url, …/content)" onChange={(e) => majApi(index, { resultUrl: e.target.value })} />
              </label>
              <label className="axe-medias__ligne">
                <span>Chemin du résultat</span>
                <input value={api.resultPath} placeholder="auto (ex. data.0.url, video.url)" onChange={(e) => majApi(index, { resultPath: e.target.value })} />
              </label>
            </details>
          </div>
        );
      })}
      <div className="axe-medias__ajouts" role="group" aria-label="Ajouter une API">
        {PREREGLAGES_API.map((p) => (
          <button
            key={p.id}
            type="button"
            title={p.aide}
            data-prereglage={p.id}
            onClick={() => patch({ mediaProviders: [...apis, nouvelleApi(p.id, apis)] })}
          >
            + {p.libelle}
          </button>
        ))}
      </div>
    </section>
  );
}

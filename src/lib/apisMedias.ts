// API personnalisées de génération de médias (Réglages > REPL).
// Le service (crates/axecode-app/src/media.rs) détecte seul le média dans la
// réponse et suit les tâches asynchrones ; ces préréglages ne font que
// remplir le formulaire pour les API les plus courantes.

import type { MediaKind, MediaProviderConfig } from "../types";

export type PrereglageApi = {
  id: string;
  libelle: string;
  valeurs: Partial<MediaProviderConfig> & { kind: MediaKind };
  aide: string;
};

export const PREREGLAGES_API: PrereglageApi[] = [
  {
    id: "openai-images",
    libelle: "Images compatibles OpenAI",
    valeurs: { name: "images-api", kind: "image", url: "https://api.openai.com/v1/images/generations", model: "gpt-image-2" },
    aide: "Toute API qui suit /v1/images/generations (OpenAI, serveurs compatibles) : changez l'URL et le modèle.",
  },
  {
    id: "openai-videos",
    libelle: "Vidéos OpenAI (Sora)",
    valeurs: {
      name: "sora",
      kind: "video",
      url: "https://api.openai.com/v1/videos",
      model: "sora-2",
      body: '{"model": "{model}", "prompt": "{prompt}", "seconds": "{seconds}", "size": "{size}"}',
    },
    aide: "Tâche suivie sur {url}/{id}, vidéo lue sur …/content.",
  },
  {
    id: "fal",
    libelle: "fal.ai (file d'attente)",
    valeurs: {
      name: "fal",
      kind: "video",
      url: "https://queue.fal.run/{model}",
      authPrefix: "Key ",
      body: '{"prompt": "{prompt}"}',
    },
    aide: "Modèle = identifiant fal (ex. fal-ai/…/text-to-video) ; suivi par status_url, résultat par response_url.",
  },
  {
    id: "replicate",
    libelle: "Replicate",
    valeurs: {
      name: "replicate",
      kind: "video",
      url: "https://api.replicate.com/v1/models/{model}/predictions",
      body: '{"input": {"prompt": "{prompt}"}}',
    },
    aide: "Modèle = propriétaire/nom ; suivi par urls.get, résultat dans output.",
  },
  {
    id: "autre",
    libelle: "Autre API",
    valeurs: { name: "api", kind: "image", url: "" },
    aide: "Corps par défaut : {\"model\": \"{model}\", \"prompt\": \"{prompt}\"}.",
  },
];

export function nouvelleApi(id: string, existantes: MediaProviderConfig[]): MediaProviderConfig {
  const p = PREREGLAGES_API.find((x) => x.id === id) ?? PREREGLAGES_API[PREREGLAGES_API.length - 1];
  const base: MediaProviderConfig = {
    name: "",
    url: "",
    model: "",
    authHeader: "",
    authPrefix: "",
    apiKey: "",
    body: "",
    pollUrl: "",
    resultUrl: "",
    resultPath: "",
    timeoutSeconds: 0,
    pollSeconds: 0,
    ...p.valeurs,
  };
  base.name = nomLibre(base.name, existantes);
  return base;
}

/// Nom unique (le service refuse deux API du même nom, sans tenir compte de la casse).
export function nomLibre(nom: string, existantes: MediaProviderConfig[]): string {
  const pris = new Set(existantes.map((a) => a.name.trim().toLowerCase()));
  if (!pris.has(nom.toLowerCase())) return nom;
  let n = 2;
  while (pris.has(`${nom}-${n}`.toLowerCase())) n += 1;
  return `${nom}-${n}`;
}

export function apisDuType(apis: MediaProviderConfig[] | undefined, kind: MediaKind): MediaProviderConfig[] {
  return (apis ?? []).filter((a) => a.kind === kind);
}

/// Gabarit JSON vide ou valide ; sinon le message affiché sous le champ.
export function erreurGabarit(body: string): string | null {
  if (!body.trim()) return null;
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? null : "Le corps doit être un objet JSON.";
  } catch {
    return "JSON invalide.";
  }
}

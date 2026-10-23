// axe:providers — configurable provider instances (custom OpenAI/Anthropic-
// compatible endpoints, Mistral, DeepSeek, xAI, Groq, Prime Inference,
// Ollama, LM Studio). Types mirror crates/axecode-core/src/provider_config.rs.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ThinkingLevel } from "../types";

export type ProviderKind =
  | "open_ai_compatible"
  | "anthropic_compatible"
  | "mistral"
  | "deep_seek"
  | "xai"
  | "groq"
  | "prime"
  | "ollama"
  | "lm_studio";

export type ModelDefinition = {
  id: string;
  label: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
};

export type ProviderConfig = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
  models: ModelDefinition[];
};

export type ProviderInstance = ProviderConfig & {
  hasApiKey: boolean;
  installed: boolean;
};

export type ModelOverride = { contextWindow?: number; maxOutputTokens?: number };

export type ProviderKindInfo = {
  kind: ProviderKind;
  label: string;
  builtinId: string | null;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
  defaultModels: ModelDefinition[];
};

export type ProviderSettingsView = {
  providers: ProviderInstance[];
  modelOverrides: Record<string, ModelOverride>;
  kinds: ProviderKindInfo[];
};

export type LocalServerProbe = {
  kind: ProviderKind;
  baseUrl: string;
  available: boolean;
  models: ModelDefinition[];
  updated: boolean;
};

export const KIND_ICONS: Record<ProviderKind, string> = {
  open_ai_compatible: "solar:plug-circle-linear",
  anthropic_compatible: "solar:plug-circle-linear",
  mistral: "simple-icons:mistralai",
  deep_seek: "solar:magnifer-zoom-in-linear",
  xai: "simple-icons:x",
  groq: "solar:bolt-linear",
  prime: "solar:cpu-bolt-linear",
  ollama: "simple-icons:ollama",
  lm_studio: "solar:monitor-linear",
};

export const providerApi = {
  get() {
    return invoke<ProviderSettingsView>("provider_settings_get");
  },
  save(providers: ProviderConfig[], apiKeys: Record<string, string>, modelOverrides: Record<string, ModelOverride>) {
    return invoke<ProviderSettingsView>("provider_settings_save", {
      input: { settings: { providers, modelOverrides }, apiKeys },
    });
  },
  discover(kind: ProviderKind, baseUrl: string, apiKey?: string, providerId?: string) {
    return invoke<ModelDefinition[]>("provider_discover_models", {
      input: { kind, baseUrl, apiKey: apiKey || null, providerId: providerId || null },
    });
  },
  detectLocal() {
    return invoke<LocalServerProbe[]>("provider_detect_local");
  },
  setModelOverride(provider: string, model: string, contextWindow?: number, maxOutputTokens?: number) {
    return invoke<ProviderSettingsView>("provider_set_model_override", {
      input: { provider, model, contextWindow: contextWindow ?? null, maxOutputTokens: maxOutputTokens ?? null },
    });
  },
};

/** Emitted on the window when configurable providers change (backend or UI). */
export const PROVIDERS_CHANGED_EVENT = "axecode:providers-changed";

/** Forward backend `axe://providers-changed` to the window event the UI listens to. */
export function bridgeProviderEvents(): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;
  void listen("axe://providers-changed", () => {
    window.dispatchEvent(new CustomEvent(PROVIDERS_CHANGED_EVENT));
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** Model-selector entry shape (kept structurally compatible with ModelEntry). */
export type CustomModelEntry = {
  value: string;
  provider: string;
  providerLabel: string;
  label: string;
  thinking: readonly ThinkingLevel[];
  defaultThinking: ThinkingLevel;
  icon: string;
};

const REASONING_LEVELS: readonly ThinkingLevel[] = ["off", "low", "medium", "high"];
const NO_REASONING: readonly ThinkingLevel[] = ["off"];

export function customModelEntries(view: ProviderSettingsView | null): CustomModelEntry[] {
  if (!view) return [];
  return view.providers
    .filter((p) => p.enabled && p.installed)
    .flatMap((p) =>
      p.models.map((m) => ({
        value: `${p.id}:${m.id}`,
        provider: p.id,
        providerLabel: p.name,
        label: m.label || m.id,
        thinking: m.supportsReasoning ? REASONING_LEVELS : NO_REASONING,
        defaultThinking: (m.supportsReasoning ? "medium" : "off") as ThinkingLevel,
        icon: KIND_ICONS[p.kind],
      })),
    );
}

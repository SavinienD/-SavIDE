import type {
  AgentMode,
  ModeModelSettings,
  ModelRef,
  OpenRouterModel,
  ThinkingLevel,
} from "../types";

export type ModelId = string;
// axe:providers — configurable instances use their own (dynamic) ids.
export type ProviderId =
  | "anthropic"
  | "openai"
  | "google"
  | "kimi"
  | "openrouter"
  | (string & {});
export type ModeModelSelection = { model: ModelId; thinking: ThinkingLevel };
export type ModeModelSelections = Record<AgentMode, ModeModelSelection>;

export type ModelEntry = {
  value: ModelId;
  provider: ProviderId;
  label: string;
  thinking: readonly ThinkingLevel[];
  defaultThinking: ThinkingLevel;
  supportsFast?: boolean;
  // axe:providers
  providerLabel?: string;
  icon?: string;
};

export const PROVIDERS: {
  value: ProviderId;
  label: string;
  icon: string;
}[] = [
  {
    value: "anthropic",
    label: "Anthropic",
    icon: "simple-icons:anthropic",
  },
  {
    value: "openai",
    label: "OpenAI",
    icon: "simple-icons:openai",
  },
  {
    value: "google",
    label: "Google",
    icon: "simple-icons:google",
  },
  {
    value: "gemini-web",
    label: "Gemini (app web)",
    icon: "simple-icons:googlegemini",
  },
  {
    value: "kimi",
    label: "Kimi",
    icon: "local:kimi",
  },
  {
    value: "openrouter",
    label: "OpenRouter",
    icon: "simple-icons:openrouter",
  },
];

export const THINKING_LEVELS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "Désactivée" },
  { value: "minimal", label: "Minimale" },
  { value: "low", label: "Faible" },
  { value: "medium", label: "Moyenne" },
  { value: "high", label: "Élevée" },
  { value: "xhigh", label: "Très élevée" },
  { value: "max", label: "Maximale" },
];

export const MODELS: ModelEntry[] = [
  {
    value: "anthropic:claude-fable-5-1",
    provider: "anthropic",
    label: "Fable 5.1",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-fable-5",
    provider: "anthropic",
    label: "Fable 5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-opus-5-5",
    provider: "anthropic",
    label: "Opus 5.5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-sonnet-5-5",
    provider: "anthropic",
    label: "Sonnet 5.5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-sonnet-5",
    provider: "anthropic",
    label: "Sonnet 5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "anthropic:claude-haiku-5-5",
    provider: "anthropic",
    label: "Haiku 5.5",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
  },
  {
    value: "openai:gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6-sol",
    provider: "openai",
    label: "GPT-6 Sol",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "openai:gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    thinking: ["off", "low", "medium", "high", "xhigh", "max"],
    defaultThinking: "medium",
    supportsFast: true,
  },
  {
    value: "google:gemini-3.8-flash",
    provider: "google",
    label: "Gemini 3.8 Flash",
    thinking: ["minimal", "low", "medium", "high"],
    defaultThinking: "high",
  },
  // axe:providers — other models included in the Google (Antigravity) subscription,
  // each verified to answer (2026-10-15). Gemini 3.6 Flash / 3.1 Pro are listed for
  // the account but refused to third-party clients (404), so they are not offered.
  {
    value: "google:gemini-3-flash-agent",
    provider: "google",
    label: "Gemini 3.5 Flash",
    thinking: ["high"],
    defaultThinking: "high",
  },
  {
    value: "google:claude-opus-4-6-thinking",
    provider: "google",
    label: "Claude Opus 4.6 (via Google)",
    thinking: ["high"],
    defaultThinking: "high",
  },
  {
    value: "google:claude-sonnet-4-6",
    provider: "google",
    label: "Claude Sonnet 4.6 (via Google)",
    thinking: ["high"],
    defaultThinking: "high",
  },
  {
    value: "google:gpt-oss-120b-medium",
    provider: "google",
    label: "GPT-OSS 120B (via Google)",
    thinking: ["medium"],
    defaultThinking: "medium",
  },
  // axe:gemini-web — models of the Google AI subscription through
  // gemini.google.com (ids = app categories, resolved per account at runtime).
  // Thinking: low = standard, high = extended thinking.
  {
    value: "gemini-web:gemini-argon",
    provider: "gemini-web",
    label: "Gemini 4 Argon (app web)",
    thinking: ["low", "high"],
    defaultThinking: "high",
  },
  {
    value: "gemini-web:gemini-pro",
    provider: "gemini-web",
    label: "Gemini 3.1 Pro (app web)",
    thinking: ["low", "high"],
    defaultThinking: "high",
  },
  {
    value: "gemini-web:gemini-flash",
    provider: "gemini-web",
    label: "Gemini 3.8 Flash (app web)",
    thinking: ["low", "high"],
    defaultThinking: "low",
  },
  {
    value: "kimi:kimi-k2.7-code",
    provider: "kimi",
    label: "Kimi K2.7 Code",
    thinking: ["high"],
    defaultThinking: "high",
  },
  {
    value: "kimi:kimi-for-coding",
    provider: "kimi",
    label: "Kimi K2.6",
    thinking: ["off", "high"],
    defaultThinking: "high",
  },
];

const OPENROUTER_THINKING: readonly ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];
const OPENROUTER_NO_THINKING: readonly ThinkingLevel[] = ["off"];

export function sanitizeOpenRouterName(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  // OpenRouter prefixes most names with the underlying provider, e.g. "OpenAI: GPT-4o".
  // The provider icon already conveys that information in SavIDE, so drop the prefix.
  const colon = raw.indexOf(":");
  if (colon <= 0) return raw;
  const tail = raw.slice(colon + 1).trim();
  return tail || raw;
}

export function modelsWithOpenRouter(
  openRouterModels: readonly OpenRouterModel[] = [],
  customModels: readonly ModelEntry[] = [], // axe:providers
): ModelEntry[] {
  return [...MODELS, ...openRouterModelEntries(openRouterModels), ...customModels];
}

export function availableModelsForProviders(
  configuredProviders: readonly string[],
  openRouterModels: readonly OpenRouterModel[] = [],
  customModels: readonly ModelEntry[] = [], // axe:providers
): ModelEntry[] {
  const configured = new Set(configuredProviders);
  return [
    ...MODELS.filter((model) => configured.has(model.provider)),
    ...(configured.has("openrouter") ? openRouterModelEntries(openRouterModels) : []),
    ...customModels.filter((model) => configured.has(model.provider)),
  ];
}

/** axe:providers — icon for a model entry (native provider icon or entry icon). */
export function modelEntryIcon(entry: ModelEntry): string | undefined {
  return PROVIDERS.find((p) => p.value === entry.provider)?.icon ?? entry.icon;
}

function openRouterModelEntries(
  openRouterModels: readonly OpenRouterModel[],
): ModelEntry[] {
  return openRouterModels.map((model) => ({
    value: modelId("openrouter", model.id),
    provider: "openrouter",
    label: sanitizeOpenRouterName(model.name) || model.id,
    thinking: model.supportsThinking ? OPENROUTER_THINKING : OPENROUTER_NO_THINKING,
    defaultThinking: model.supportsThinking ? "medium" : "off",
  }));
}

export function modelIdFromRef(model: ModelRef | null | undefined): ModelId {
  if (model?.provider && model.name) {
    return modelId(model.provider, normalizedModelName(model.provider, model.name));
  }
  return MODELS[0].value;
}

export function modelRefFromId(model: ModelId): ModelRef {
  const separator = model.indexOf(":");
  if (separator < 0) return { provider: "anthropic", name: model };
  const provider = model.slice(0, separator);
  const name = model.slice(separator + 1);
  return { provider, name };
}

export function thinkingFromRef(
  model: ModelRef | null | undefined,
): ThinkingLevel {
  if (model?.provider === "google") {
    if (model.name.endsWith("-low")) return "low";
    if (model.name.endsWith("-medium")) return "medium";
    if (model.name.endsWith("-high")) return "high";
    if (model.effort === "low" || model.effort === "medium" || model.effort === "high") {
      return model.effort;
    }
    if (model.effort === "none") {
      // Pro variants don't support `minimal`; clamp to low so we never send
      // an invalid thinking level for those models.
      return model.name.includes("-pro") ? "low" : "minimal";
    }
    return "high";
  }
  if (model?.provider === "kimi") {
    if (model.name === "kimi-k2.7-code") return "high";
    if (model.effort === "none") return "off";
    return "high";
  }
  if (model?.provider === "openrouter") {
    if (model.effort === "none") return "off";
    if (
      model.effort === "low" ||
      model.effort === "medium" ||
      model.effort === "high" ||
      model.effort === "xhigh"
    ) {
      return model.effort;
    }
    if (model.effort === "max") {
      return "xhigh";
    }
    return "medium";
  }
  if (model?.effort === "none") return "off";
  if (model?.effort === "xhigh") return "xhigh";
  if (
    model?.provider === "openai" &&
    model.effort === "max" &&
    !supportsOpenAiMaxEffort(model.name)
  ) {
    return "xhigh";
  }
  if (
    model?.effort === "low" ||
    model?.effort === "medium" ||
    model?.effort === "high" ||
    model?.effort === "max"
  ) {
    return model.effort;
  }
  return "medium";
}

export function modelRefWithThinking(
  model: ModelRef,
  thinking: ThinkingLevel,
): ModelRef {
  if (model.provider === "google") {
    const name = normalizedGoogleModelName(model.name);
    if (thinking === "off") return { ...model, name, effort: "low" };
    if (thinking === "minimal") {
      // Pro variants reject `minimal` server-side; clamp to low.
      return name.includes("-pro")
        ? { ...model, name, effort: "low" }
        : { ...model, name, effort: "none" };
    }
    if (thinking === "xhigh" || thinking === "max") return { ...model, name, effort: "high" };
    return { ...model, name, effort: thinking };
  }
  if (model.provider === "kimi" && model.name === "kimi-k2.7-code") {
    return { ...model, effort: "high" };
  }
  if (thinking === "off") return { ...model, effort: "none" };
  if (model.provider === "kimi") return { ...model, effort: "high" };
  if (model.provider === "openrouter" && thinking === "max") {
    return { ...model, effort: "xhigh" };
  }
  // `minimal` is Gemini-only on the backend. The Google branch above already
  // handled it; for any other provider that ever surfaces it, clamp to low.
  if (thinking === "minimal") return { ...model, effort: "low" };
  return { ...model, effort: thinking };
}

export function selectionFromRef(
  model: ModelRef | null | undefined,
): ModeModelSelection {
  return {
    model: modelIdFromRef(model),
    thinking: thinkingFromRef(model),
  };
}

function modelId(provider: string, name: string): ModelId {
  return `${provider}:${name}`;
}

function supportsOpenAiMaxEffort(modelName: string): boolean {
  return modelName === "gpt-6" || modelName.startsWith("gpt-6-");
}

function normalizedModelName(provider: string, name: string): string {
  if (provider === "google") return normalizedGoogleModelName(name);
  return name;
}

function normalizedGoogleModelName(name: string): string {
  if (name === "gemini-3.8-flash-preview") return "gemini-3.8-flash";
  if (
    name === "gemini-3.8-flash-low" ||
    name === "gemini-3.8-flash-medium" ||
    name === "gemini-3.8-flash-high"
  ) {
    return "gemini-3.8-flash";
  }
  return name;
}

export function selectionsFromSettings(
  settings: ModeModelSettings | null | undefined,
  fallback: ModelRef,
): ModeModelSelections {
  return {
    act: selectionFromRef(settings?.act ?? fallback),
    plan: selectionFromRef(settings?.plan ?? fallback),
    goal: selectionFromRef(settings?.goal ?? settings?.act ?? fallback),
  };
}

// axe:sub-m — models of the configured providers, as `provider/model` choices.
import { useEffect, useState } from "react";
import { api } from "../../lib/ipc";
import { availableModelsForProviders, modelRefFromId } from "../../lib/models";
import { customModelEntries, providerApi } from "../../axe/providers";

export type ModelChoice = { value: string; label: string; provider: string; name: string };

export function useModelChoices(): ModelChoice[] {
  const [choices, setChoices] = useState<ModelChoice[]>([]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [providers, openRouter, custom] = await Promise.all([
          api.listConfiguredModelProviders(),
          api.listOpenRouterModels().catch(() => []),
          providerApi.get().catch(() => null),
        ]);
        const entries = availableModelsForProviders(providers, openRouter, customModelEntries(custom));
        const seen = new Set<string>();
        const list: ModelChoice[] = [];
        for (const entry of entries) {
          const ref = modelRefFromId(entry.value);
          const value = `${ref.provider}/${ref.name}`;
          if (seen.has(value)) continue;
          seen.add(value);
          list.push({ value, label: `${entry.providerLabel ?? ref.provider} · ${entry.label}`, provider: ref.provider, name: ref.name });
        }
        if (alive) setChoices(list);
      } catch {
        if (alive) setChoices([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  return choices;
}

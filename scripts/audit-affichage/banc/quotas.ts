// Banc — lot quotas : quotas de plusieurs comptes (Claude, deux ChatGPT dont un à renouveler),
// jauge du contexte et minuteur du cache (`sessions.context`) pour les scènes « quotas-* »,
// « jauge-* » et « reprise-* ». Formes réelles : src-tauri/src/quota.rs et
// crates/axecode-daemon/src/contexte_rpc.rs.
/* eslint-disable @typescript-eslint/no-explicit-any */
const H = 3_600_000;
const MIN = 60_000;

const fenetre = (id: string, label: string, utilization: number, resetsAtMs: number, windowMinutes: number) => ({
  id, label, utilization, resetsAt: null, resetsAtMs, windowMinutes, projectedExhaustionMs: null, exhaustsBeforeReset: false,
});

export function simulationQuotas(scene: Record<string, unknown>, base: Record<string, (a: any, brut: any) => unknown>) {
  const t0 = Date.now();
  const providers = [
    { provider: "anthropic", label: "Claude", account: "claire.lemaitre@cabinet-martin-et-associes-avocats.fr", plan: "max", supported: true, error: null,
      windows: [fenetre("five_hour", "5 h", 86, t0 + 2 * H + 5 * MIN, 300), fenetre("seven_day", "7 j", 41, t0 + 3 * 24 * H, 10_080), fenetre("seven_day_opus", "7 j Opus", 12, t0 + 3 * 24 * H, 10_080)] },
    { provider: "openai", label: "ChatGPT", account: "atelier.durand@gmail.com", plan: "plus", supported: true, error: null,
      windows: [fenetre("five_hour", "5 h", 23, t0 + 50 * MIN, 300), fenetre("seven_day", "7 j", 64, t0 + 5 * 24 * H, 10_080)] },
    { provider: "openai~2", label: "ChatGPT", account: "compta@cabinet-martin.fr", plan: null, supported: true,
      error: "connexion à renouveler\u00a0: elle se renouvelle au prochain message envoyé avec ce compte", windows: [] },
    { provider: "ollama", label: "ollama", account: null, plan: null, supported: false, error: null, windows: [] },
  ];
  // Dernier appel : 84 k jetons sur 200 k, compactage à 160 k, cache de 5 min posé il y a 1 min.
  const appel = () => ({
    jetonsContexte: 84_000, jetonsSortie: 900, cacheLu: 80_000, cacheEcrit: 2_800, fenetre: 200_000, seuilCompaction: 160_000,
    debutMs: t0 - MIN, finMs: t0 - 40_000, cacheTtlS: 300, cacheExpireMs: t0 + 4 * MIN, modele: "claude-opus-5-5",
  });
  return {
    provider_quota: () => ({ fetchedAtMs: Date.now(), providers }),
    daemon_call: (a: any, brut: any) => {
      if (a?.method === "sessions.context") return scene.quotas === "sans-jauge" ? { appel: null } : { appel: appel() };
      return base.daemon_call ? base.daemon_call(a, brut) : null;
    },
  };
}

/** Reprises prévues (stockage local « reprise.file ») : la conversation c-001 et un sous-agent au nom long. */
export function reprisesBanc(t0 = Date.now()) {
  const r = (sessionId: string, parentId: string | null, nom: string) => ({
    sessionId, parentId, nom, provider: "anthropic", aMs: t0 + 2 * H + 6 * MIN, source: "quota", essais: 0, creeMs: t0,
  });
  return [r("c-001", null, "Conversation du banc"), r("sa-1", "c-001", "t-lotA-correction-des-colonnes-du-banc-a-800-px-et-du-compositeur")];
}

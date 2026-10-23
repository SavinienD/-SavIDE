// axe:remote — what a remote conversation shows, built from the session
// journal (`sessions.tree`) instead of the bare message history, so that turn
// errors (provider missing, AI credit exhausted, monthly cap…) are visible.
// Also the models proposed for a remote session: the service protocol has no
// method listing its providers, so the Axe Cloud models (provider `axe-cloud`
// = cost meter of the Axe Cloud service) come first, then the models already
// used by sessions of that machine.
import type { JournalEntry, JournalTree, SessionMeta } from "./agentsApi";
import { erreurMoteurEnFrancais } from "../../lib/erreursMoteur";

export type ModelRefLite = { provider: string; name: string };
export type ModelChoice = ModelRefLite & { label: string };

export const AXE_CLOUD_MODELS: ModelChoice[] = [
  { provider: "axe-cloud", name: "claude-opus-5-5", label: "Axe Cloud · Claude Opus 5.5" },
  { provider: "axe-cloud", name: "claude-sonnet-5-5", label: "Axe Cloud · Claude Sonnet 5.5" },
  { provider: "axe-cloud", name: "claude-haiku-5-5", label: "Axe Cloud · Claude Haiku 5.5" },
];
export const DEFAULT_REMOTE_MODEL: ModelChoice = AXE_CLOUD_MODELS[0];

export const modelKey = (m: ModelRefLite) => `${m.provider}/${m.name}`;

/** `fournisseur/modèle` → model reference (null when incomplete). */
export function parseModel(value: string): ModelRefLite | null {
  const [provider, ...rest] = value.trim().split("/");
  const name = rest.join("/").trim();
  return provider && provider.trim() && name ? { provider: provider.trim(), name } : null;
}

/** Axe Cloud models, then the models of the sessions of this machine (most
 *  recent first), then `extra` (e.g. the current or remembered model). */
export function modelChoices(sessions: SessionMeta[], ...extra: (ModelRefLite | null | undefined)[]): ModelChoice[] {
  const seen = new Map<string, ModelChoice>(AXE_CLOUD_MODELS.map((m) => [modelKey(m), m]));
  const used = [...sessions].sort((a, b) => b.updatedAtMs - a.updatedAtMs).map((s) => s.model);
  for (const m of [...used, ...extra]) {
    if (!m?.provider || !m.name || seen.has(modelKey(m))) continue;
    seen.set(modelKey(m), { provider: m.provider, name: m.name, label: modelKey(m) });
  }
  return [...seen.values()];
}

const REMEMBERED = "axe.remote-model.";

/** Last model chosen for a new session on this connection, else Axe Cloud Opus. */
export function rememberedModel(connectionId: string): ModelRefLite {
  try {
    return parseModel(localStorage.getItem(REMEMBERED + connectionId) ?? "") ?? DEFAULT_REMOTE_MODEL;
  } catch {
    return DEFAULT_REMOTE_MODEL;
  }
}

export function rememberModel(connectionId: string, model: ModelRefLite): void {
  try {
    localStorage.setItem(REMEMBERED + connectionId, modelKey(model));
  } catch {
    /* private mode: nothing to remember */
  }
}

/** Readable explanation of a turn error raised on the remote service. */
export function explainTurnError(raw: string): string {
  const text = raw.replace(/^runtime error:\s*/i, "").trim();
  const provider = /provider `([^`]+)` is not configured/i.exec(text);
  if (provider) {
    return `Le service distant ne sait pas servir le fournisseur « ${provider[1]} ». Choisissez un modèle Axe Cloud (par exemple ${modelKey(DEFAULT_REMOTE_MODEL)}) dans la liste « Modèle » ci-dessus, puis renvoyez votre message.`;
  }
  if (/credit balance is too low|insufficient[_ ]?(credit|balance|funds)/i.test(text)) {
    return "Crédit IA épuisé : le compte Anthropic d'Axe Cloud doit être rechargé (console.anthropic.com > Plans & Billing). Aucune réponse n'est possible d'ici là.";
  }
  const cap = /(Plafond mensuel IA atteint[^\n]*)/i.exec(text);
  if (cap) return cap[1];
  if (/axecode_kernel package not found/i.test(text)) {
    return "Le noyau Python de SavIDE est absent sur la machine distante (installation du service incomplète) : à signaler à l'administrateur.";
  }
  if (/rejected the API key|authentication_error|invalid x-api-key|\b401\b/i.test(text)) {
    return "Clé IA refusée par le fournisseur (clé Axe Cloud absente, expirée ou révoquée) : à signaler à l'administrateur.";
  }
  if (/rate limited|rate_limit_error|overloaded|\b429\b|\b529\b/i.test(text)) {
    return "Fournisseur IA saturé ou limite de débit atteinte : réessayez dans un instant.";
  }
  if (/network error|connection refused|timed out|dns error|error sending request/i.test(text)) {
    return "Le service distant n'arrive pas à joindre le fournisseur IA (réseau) : réessayez dans un instant.";
  }
  if (/worker crashed repeatedly/i.test(text)) {
    return "Le moteur de la session a planté plusieurs fois de suite : renvoyez le message ; si cela recommence, signalez-le.";
  }
  if (/no such file or directory|os error 2\b/i.test(text)) {
    return "Fichier ou dossier introuvable sur la machine distante (le dossier de travail de la session existe-t-il ?). Créez une nouvelle session avec un dossier existant, ou sans dossier (conversation libre).";
  }
  return text ? erreurMoteurEnFrancais(text) : "Erreur inconnue du service distant.";
}

/** Readable explanation of a failed call to the remote service. */
export function explainConnectionError(raw: string): string {
  const text = raw.replace(/^Error:\s*/i, "").trim();
  if (/authentification refusée|\bHTTP 401\b/i.test(text)) {
    return "Authentification refusée par le service distant : reconnectez-vous (Axe Cloud) ou vérifiez le jeton de la connexion.";
  }
  if (/\bHTTP 403\b/i.test(text)) return "Accès refusé : l'SavIDE est réservé aux administrateurs.";
  if (/\bHTTP (302|303|307)\b/i.test(text)) return "Le service distant demande une connexion : reconnectez-vous à Axe Cloud.";
  if (/\bHTTP (502|503|504)\b/i.test(text)) {
    return "Service SavIDE indisponible pour l'instant (démarrage ou maintenance) : réessayez dans un instant.";
  }
  if (/timed out|délai/i.test(text)) return "Le service distant ne répond pas (délai dépassé) : réessayez dans un instant.";
  if (/tunnel SSH/i.test(text)) return text;
  if (/session busy/i.test(text)) return "L'agent travaille encore : attendez la fin du tour ou cliquez sur « Arrêter ».";
  return `Service distant : ${text ? erreurMoteurEnFrancais(text) : "erreur inconnue"}`;
}

export type RemoteItem =
  | { type: "message"; key: string; role: string; text: string }
  | { type: "note"; key: string; tone: "info" | "error"; text: string; detail?: string };

/** Entries from the root to the leaf (current branch), oldest first. */
export function branchEntries(tree: JournalTree): JournalEntry[] {
  const byId = new Map(tree.entries.map((e) => [e.id, e]));
  const path: JournalEntry[] = [];
  let cursor = tree.leaf ? byId.get(tree.leaf) : undefined;
  let guard = tree.entries.length + 1;
  while (cursor && guard-- > 0) {
    path.push(cursor);
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }
  return path.reverse();
}

type Part = { type?: string; text?: string; name?: string; input?: unknown };

function partsText(parts: Part[]): string {
  return parts
    .map((p) => {
      if (p.type === "text" || p.type === undefined) return p.text ?? "";
      if (p.type === "tool_call") {
        const input = p.input as { code?: string } | string | undefined;
        const code = typeof input === "string" ? input : input?.code;
        return code ? `▸ python\n${code}` : `▸ ${p.name ?? "outil"}`;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const isSystemReminder = (text: string) => /^\s*<system_reminder>[\s\S]*<\/system_reminder>\s*$/.test(text);

/** Displayable items of a branch: messages, errors and a few notes. */
export function buildRemoteItems(entries: JournalEntry[]): RemoteItem[] {
  const items: RemoteItem[] = [];
  for (const e of entries) {
    if (e.kind === "message") {
      const message = e.message as { role?: string; parts?: Part[] } | undefined;
      const text = partsText(message?.parts ?? []);
      if (!text || isSystemReminder(text)) continue;
      items.push({ type: "message", key: e.id, role: message?.role ?? "assistant", text });
    } else if (e.kind === "extension" && e.name === "turn_error") {
      const raw = String((e.payload as { error?: unknown } | undefined)?.error ?? "");
      const text = explainTurnError(raw);
      const detail = raw.trim() && raw.trim() !== text ? raw.trim() : undefined;
      items.push({ type: "note", key: e.id, tone: "error", text, detail });
    } else if (e.kind === "extension" && e.name === "question") {
      const p = e.payload as { question?: string; title?: string } | undefined;
      items.push({ type: "note", key: e.id, tone: "info", text: `Question de l'agent : ${p?.question ?? p?.title ?? ""}` });
    } else if (e.kind === "model_switch") {
      const to = e.to as ModelRefLite | undefined;
      items.push({ type: "note", key: e.id, tone: "info", text: `Modèle : ${to ? modelKey(to) : "?"}` });
    } else if (e.kind === "compaction") {
      items.push({ type: "note", key: e.id, tone: "info", text: "Conversation compactée (résumé automatique)." });
    }
  }
  return items;
}

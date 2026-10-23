// axe:webui — turns a journal (entries along the current branch) plus live
// stream events into displayable items.
import type { ChatMessage, JournalEntry, JournalTree } from "./api";
import { erreurMoteurEnFrancais } from "../../src/lib/erreursMoteur";

export type ReplItem = {
  type: "repl";
  key: string;
  callId: string;
  code: string;
  output?: string;
  isError?: boolean;
  durationMs?: number;
  live?: string;
  running: boolean;
  fileChanges?: string[];
};

export type Item =
  | { type: "user"; key: string; text: string; images: string[]; ts: number }
  | { type: "assistant"; key: string; text: string; thinking: string; ts: number; streaming?: boolean }
  | ReplItem
  | { type: "note"; key: string; text: string; tone?: "error" | "info" };

/** Entries from the root to the leaf (current branch), oldest first. */
export function branch(tree: JournalTree): JournalEntry[] {
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

function messageText(message: ChatMessage, type: "text" | "thinking"): string {
  return message.parts
    .filter((p) => p.type === type)
    .map((p) => (p as { text: string }).text)
    .join("");
}

function isSystemReminder(text: string): boolean {
  return /^\s*<system_reminder>[\s\S]*<\/system_reminder>\s*$/.test(text);
}

export function buildItems(entries: JournalEntry[]): Item[] {
  const items: Item[] = [];
  const repls = new Map<string, ReplItem>();
  for (const e of entries) {
    switch (e.kind) {
      case "message": {
        const message = e.message as ChatMessage;
        if (message.role === "user") {
          const text = messageText(message, "text");
          if (!text && message.parts.every((p) => p.type === "tool_result")) break;
          if (isSystemReminder(text)) break;
          const images = message.parts
            .filter((p) => p.type === "image")
            .map((p) => {
              const img = p as { media_type: string; data: string };
              return `data:${img.media_type};base64,${img.data}`;
            });
          items.push({ type: "user", key: e.id, text, images, ts: e.ts });
        } else {
          const text = messageText(message, "text");
          const thinking = messageText(message, "thinking");
          if (text || thinking) items.push({ type: "assistant", key: e.id, text, thinking, ts: e.ts });
          for (const part of message.parts) {
            if (part.type !== "tool_call") continue;
            const input = part.input as { code?: string } | string;
            const code = typeof input === "string" ? input : input?.code ?? "";
            const item: ReplItem = { type: "repl", key: `${e.id}:${part.id}`, callId: part.id, code, running: true };
            repls.set(part.id, item);
            items.push(item);
          }
        }
        break;
      }
      case "repl_call": {
        if (repls.has(String(e.call_id))) break;
        const item: ReplItem = {
          type: "repl",
          key: e.id,
          callId: String(e.call_id),
          code: String(e.code ?? ""),
          running: true,
        };
        repls.set(item.callId, item);
        items.push(item);
        break;
      }
      case "repl_result": {
        const callId = String(e.call_id);
        let item = repls.get(callId);
        if (!item) {
          item = { type: "repl", key: e.id, callId, code: "", running: false };
          repls.set(callId, item);
          items.push(item);
        }
        item.output = String(e.output ?? "");
        item.isError = Boolean(e.is_error);
        item.durationMs = Number(e.duration_ms ?? 0);
        item.running = false;
        break;
      }
      case "compaction":
        items.push({ type: "note", key: e.id, text: `Conversation compactée : ${String(e.summary ?? "").slice(0, 400)}` });
        break;
      case "model_switch": {
        const to = e.to as { provider?: string; name?: string } | undefined;
        items.push({ type: "note", key: e.id, text: `Modèle : ${to?.provider ?? "?"} / ${to?.name ?? "?"}` });
        break;
      }
      case "peer_message":
        items.push({ type: "note", key: e.id, text: `Message de ${String(e.from_session ?? "?")} : ${String(e.text ?? "")}` });
        break;
      case "fork":
        items.push({ type: "note", key: e.id, text: "Conversation dérivée d'une autre session." });
        break;
      case "extension":
        if (e.name === "turn_error") {
          const payload = e.payload as { error?: string } | undefined;
          const brut = payload?.error ?? "";
          const traduit = brut ? erreurMoteurEnFrancais(brut) : "";
          items.push({ type: "note", key: e.id, tone: "error", text: traduit && traduit !== brut ? traduit : `Erreur : ${brut || "inconnue"}` });
        } else if (e.name === "question") {
          const payload = e.payload as { question?: string; title?: string } | undefined;
          items.push({ type: "note", key: e.id, text: `Question de l'agent : ${payload?.question ?? payload?.title ?? JSON.stringify(e.payload)}` });
        }
        break;
      default:
        break;
    }
  }
  // A result never arrived for calls of older, finished turns.
  return items;
}

export function workspaceLabel(workspaceId: string): string {
  const parts = workspaceId.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? workspaceId;
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return new Date(ms).toLocaleDateString("fr-FR");
}

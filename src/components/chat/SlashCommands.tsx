// Session slash commands (/goal, /autonomous, /heartbeat, /compact, /refine,
// /tree, /login, /settings): parser, autocompletion menu and client-side
// handlers. Commands that drive the agent (/goal, /autonomous, /heartbeat)
// are sent as the user message and interpreted by the session service.
import { useMemo, useState, type KeyboardEvent } from "react";
import { harnessApi } from "../settings/harnessApi";
import { demanderSectionReglages } from "../../lib/sectionReglages";
import "./slash.css";

export type SlashCommandSpec = {
  name: string;
  usage: string;
  description: string;
  /** Handled in the IDE instead of being sent to the agent. */
  client?: boolean;
};

export const SLASH_COMMANDS: SlashCommandSpec[] = [
  { name: "goal", usage: "/goal <texte> [--budget N] | pause | resume | done | clear", description: "Objectif persistant de la session (icône à côté du modèle)" },
  { name: "autonomous", usage: "/autonomous [--max-turns N] [--max-tokens N] [--timeout-ms N] [--gate \"cmd\"] [tâche]", description: "Continuation bornée, porte de validation optionnelle (stop pour arrêter)" },
  { name: "heartbeat", usage: "/heartbeat <intervalle> <message> | off", description: "Réveil périodique de l'agent, ex. /heartbeat 1m coucou" },
  { name: "compact", usage: "/compact [directive]", description: "Compacter la conversation (traité par l'agent : compact.run)" },
  { name: "refine", usage: "/refine [focus]", description: "Améliorer le harnais à partir de cette session", client: true },
  { name: "tree", usage: "/tree", description: "Arbre du journal de la session, retour à un point", client: true },
  { name: "login", usage: "/login", description: "Connexion aux fournisseurs (Réglages > Fournisseurs)", client: true },
  { name: "settings", usage: "/settings [section]", description: "Ouvrir les réglages", client: true },
];

export type ParsedSlash = { name: string; rest: string; spec: SlashCommandSpec | null };

export function parseSlashCommand(text: string): ParsedSlash | null {
  const trimmed = text.trim();
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return {
    name,
    rest: (match[2] ?? "").trim(),
    spec: SLASH_COMMANDS.find((c) => c.name === name) ?? null,
  };
}

export type SlashContext = {
  workspacePath: string;
  conversationId: string;
  compact: (directive?: string) => Promise<void> | void;
  notify?: (message: string) => void;
};

export const OPEN_SETTINGS_EVENT = "axecode:open-settings-section";
export const OPEN_TREE_EVENT = "axe:open-session-tree";
/** Demande à l'espace (IDE ou conversation sans dossier) d'OUVRIR le volet des Réglages. */
export const OUVRIR_REGLAGES_EVENT = "axe:ouvrir-reglages";

/** Ouvre les Réglages sur `section`, que le volet soit déjà monté ou non (avant : rien
 *  ne l'ouvrait, et un volet monté plus tard restait sur « À propos »). */
export function ouvrirReglages(section: string): void {
  demanderSectionReglages(section);
  window.dispatchEvent(new CustomEvent(OUVRIR_REGLAGES_EVENT, { detail: { section } }));
}

/**
 * Runs a client-side command. Returns `true` when the text was consumed
 * (the composer must not send it to the agent).
 */
export async function runClientSlashCommand(text: string, ctx: SlashContext): Promise<boolean> {
  const parsed = parseSlashCommand(text);
  if (!parsed?.spec?.client) return false;
  switch (parsed.name) {
    case "compact":
      await ctx.compact(parsed.rest || undefined);
      return true;
    case "refine": {
      try {
        const started = await harnessApi.refineStart(ctx.workspacePath, ctx.conversationId, parsed.rest || undefined);
        ctx.notify?.(
          started
            ? "Affinage lancé : il s'applique dès qu'il est prêt (suivi et arrêt dans Réglages > Harnais > Affinages)."
            : "Un affinage est déjà en cours pour cette conversation (Réglages > Harnais > Affinages pour l'arrêter).",
        );
      } catch (error) {
        ctx.notify?.(`/refine impossible : ${String(error)}`);
      }
      return true;
    }
    case "tree":
      window.dispatchEvent(new CustomEvent(OPEN_TREE_EVENT, { detail: { conversationId: ctx.conversationId } }));
      return true;
    case "login":
      ouvrirReglages("providers");
      return true;
    case "settings":
      ouvrirReglages(parsed.rest || "about");
      return true;
    default:
      return false;
  }
}

/** Autocompletion for `/command` while the composer holds a single word. */
export function useSlashCommandMenu(text: string, setText: (value: string) => void) {
  const [index, setIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const matches = useMemo(() => {
    const m = /^\/([a-z0-9_-]*)$/i.exec(text);
    if (!m || dismissed === text) return [];
    const q = m[1].toLowerCase();
    return SLASH_COMMANDS.filter((c) => c.name.startsWith(q) && c.name !== q);
  }, [text, dismissed]);

  const current = Math.min(index, Math.max(matches.length - 1, 0));

  const complete = (spec: SlashCommandSpec) => {
    setText(`/${spec.name} `);
    setIndex(0);
  };

  /** Returns true when the key was handled by the menu. */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (matches.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((current + 1) % matches.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((current - 1 + matches.length) % matches.length);
      return true;
    }
    if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
      event.preventDefault();
      complete(matches[current]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDismissed(text);
      return true;
    }
    return false;
  };

  const menu =
    matches.length > 0 ? (
      <div className="axe-slash-menu" role="listbox" aria-label="Commandes">
        {matches.map((spec, i) => (
          <button
            key={spec.name}
            type="button"
            role="option"
            aria-selected={i === current}
            data-active={i === current ? "true" : "false"}
            className="axe-slash-menu__item"
            onMouseDown={(e) => {
              e.preventDefault();
              complete(spec);
            }}
          >
            <code>/{spec.name}</code>
            <span className="axe-slash-menu__desc">{spec.description}</span>
            <span className="axe-slash-menu__usage">{spec.usage}</span>
          </button>
        ))}
      </div>
    ) : null;

  return { menu, onKeyDown, active: matches.length > 0 };
}

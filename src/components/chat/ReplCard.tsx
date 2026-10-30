import { PreCopiable } from "./PreCopiable"; // axe:copier-code
import { useMemo, useState, type ReactNode } from "react";

// axe:repl — condensed card for one `python(code)` execution: first line of
// code + output summary; expands to the full code and the raw output.

type ReplMeta = {
  callId?: string;
  summary?: string;
  isError?: boolean;
  durationMs?: number;
  stdout?: string;
  stderr?: string;
  value?: string | null;
  error?: string | null;
  fileChanges?: { path: string }[];
};

export type ReplCardProps = {
  status: "running" | "done" | "error";
  code?: string;
  output?: string;
  isError?: boolean;
  meta?: Record<string, unknown> | null;
  onOpenFile?: (path: string) => void;
  /** Shown under the header even when the card is folded (images of the result). */
  children?: ReactNode;
};

function firstCodeLine(code: string): string {
  const line = code.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#"));
  return (line ?? code.split(/\r?\n/)[0] ?? "").trim();
}

function parseCode(argsPretty?: string): string {
  if (!argsPretty) return "";
  try {
    const parsed = JSON.parse(argsPretty) as { code?: string };
    if (typeof parsed?.code === "string") return parsed.code;
  } catch {
    // argsPretty already holds raw code
  }
  return argsPretty;
}

// axe:lisible - libelle humain deduit du code, sans aucun appel au modele.
function libelle(code: string): string {
  const c = code;
  const f = (re: RegExp) => c.match(re)?.[1];
  if (/files\.edit\(/.test(c)) return "Modifie " + (f(/files\.edit\(\s*["']([^"']+)/) ?? "un fichier");
  if (/files\.write\(/.test(c)) return "Écrit " + (f(/files\.write\(\s*["']([^"']+)/) ?? "un fichier");
  if (/files\.read\(/.test(c)) return "Lit " + (f(/files\.read\(\s*["']([^"']+)/) ?? "un fichier");
  if (/tauri build|build\.sh/.test(c)) return "Construit l'installeur";
  if (/time\.sleep\(/.test(c)) return "Attend la fin d'une tâche";
  if (/caddy/i.test(c)) return "Configure Caddy";
  if (/git commit/.test(c)) return "Validation (commit) + vérification";
  if (/tsc --noEmit/.test(c)) return "Correctif + vérification TypeScript";
  if (/grep|sed -n/.test(c)) return "Lit / cherche dans le code";
  if (/web\.(search|fetch)/.test(c)) return "Recherche web";
  if (/todo\.|goal\.|heartbeat\./.test(c)) return "Met à jour la liste de tâches";
  if (/ssh |scp /.test(c)) return "Commande sur la VM";
  return "";
}

export function ReplCard({ status, code: rawCode, output, isError, meta, onOpenFile, children }: ReplCardProps) {
  const [open, setOpen] = useState(false);
  const repl = (meta?.repl ?? null) as ReplMeta | null;
  const code = useMemo(() => parseCode(rawCode), [rawCode]);
  const failed = isError || repl?.isError || status === "error";
  const running = status === "running";
  const head = firstCodeLine(code) || "python";
  const liveLine = running
    ? (output ?? "").split(/\r?\n/).filter((l) => l.trim()).pop()
    : undefined;
  const summary = running
    ? liveLine || "exécution…"
    : repl?.summary || (output ?? "").split(/\r?\n/).find((l) => l.trim()) || "(aucune sortie)";
  const duration =
    typeof repl?.durationMs === "number" && !running
      ? repl.durationMs >= 1000
        ? `${(repl.durationMs / 1000).toFixed(1).replace(".", ",")} s`
        : `${repl.durationMs} ms`
      : null;

  return (
    <div className="repl-card" data-status={running ? "running" : failed ? "error" : "done"}>
      <button
        type="button"
        className="repl-card__head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Replier" : "Déplier le code et la sortie"}
      >
        <span className="repl-card__glyph" aria-hidden>
          {running ? "◌" : failed ? "✕" : "›_"}
        </span>
        {libelle(code) ? <strong className="repl-card__label">{libelle(code)}</strong> : null}
        <code className="repl-card__code">{head}</code>
        <span className="repl-card__summary">{summary}</span>
        {duration && <span className="repl-card__duration">{duration}</span>}
      </button>
      {children}
      {open && (
        <div className="repl-card__body">
          <PreCopiable className="repl-card__pre repl-card__pre--code">{code}</PreCopiable>
          {repl?.stdout ? <PreCopiable className="repl-card__pre">{repl.stdout}</PreCopiable> : null}
          {repl?.value ? (
            <PreCopiable className="repl-card__pre repl-card__pre--value">{`Sortie : ${repl.value}`}</PreCopiable>
          ) : null}
          {repl?.stderr ? <PreCopiable className="repl-card__pre repl-card__pre--err">{repl.stderr}</PreCopiable> : null}
          {repl?.error ? <PreCopiable className="repl-card__pre repl-card__pre--err">{repl.error}</PreCopiable> : null}
          {!repl && output ? <PreCopiable className="repl-card__pre">{output}</PreCopiable> : null}
          {repl?.fileChanges?.length ? (
            <div className="repl-card__files">
              {repl.fileChanges.map((change) => (
                <button
                  key={change.path}
                  type="button"
                  className="repl-card__file"
                  onClick={() => onOpenFile?.(change.path)}
                >
                  {change.path}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

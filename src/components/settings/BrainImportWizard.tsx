import { useEffect, useState } from "react";
import {
  harnessApi,
  type BrainDetection,
  type BrainImportReport,
  type HarnessScope,
} from "./harnessApi";

type Props = {
  workspacePath: string;
  onImported?: () => void;
};

const KIND_LABEL: Record<string, string> = {
  prompt_note: "note de prompt",
  memory: "mémoire",
  skill: "skill",
  subagent_spec: "sous-agent",
};

/**
 * One-shot import of the legacy brain kit (`<workspace>/brain/`) into the
 * harness. Renders nothing when no brain folder is found.
 */
export function BrainImportWizard({ workspacePath, onImported }: Props) {
  const [detection, setDetection] = useState<BrainDetection | null>(null);
  const [memoryScope, setMemoryScope] = useState<HarnessScope>("global");
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<BrainImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const detect = async (scope: HarnessScope = memoryScope) => {
    try {
      setDetection(await harnessApi.brainDetect(workspacePath, { memoryScope: scope }));
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    void detect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath]);

  if (!detection || (!detection.found && !detection.agentsMdObsolete)) return null;

  const pending = detection.items.filter((item) => !item.alreadyImported);
  const allDone = detection.found && pending.length === 0;

  const toggle = (rel: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const runImport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await harnessApi.brainImport(workspacePath, {
        memoryScope,
        exclude: [...excluded],
      });
      setReport(result);
      await detect();
      onImported?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="axe-harness__brain">
      {detection.agentsMdObsolete ? (
        <p className="axe-harness__banner">
          AGENTS.md obsolète : il contient encore le rituel « Setup-Brain ». Le harnais le remplace —
          vous pouvez retirer ces instructions d'AGENTS.md après l'import.
        </p>
      ) : null}
      {detection.found ? (
        <div className="axe-harness__brain-head">
          <span>
            {allDone
              ? "Kit brain déjà importé dans le harnais."
              : `Kit brain détecté : ${pending.length} fichier(s) à importer.`}
          </span>
          {!allDone ? (
            <button type="button" className="axe-harness__btn" onClick={() => setOpen(!open)}>
              {open ? "Fermer" : "Importer le kit brain…"}
            </button>
          ) : null}
        </div>
      ) : null}

      {open && !allDone ? (
        <div className="axe-harness__brain-body">
          <label className="axe-harness__field">
            <span>Portée des mémoires (memory.md, corrections.md)</span>
            <select
              value={memoryScope}
              onChange={(e) => {
                const scope = e.target.value as HarnessScope;
                setMemoryScope(scope);
                void detect(scope);
              }}
            >
              <option value="global">Globale (vous suit partout)</option>
              <option value="project">Projet</option>
            </select>
          </label>
          <ul className="axe-harness__brain-list">
            {pending.map((item) => (
              <li key={item.relativePath}>
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.has(item.relativePath)}
                    onChange={() => toggle(item.relativePath)}
                  />
                  <code>brain/{item.relativePath}</code>
                  <span className="axe-harness__muted">
                    → {KIND_LABEL[item.kind]} {item.scope === "global" ? "globale" : "projet"}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {detection.plans.length ? (
            <p className="axe-harness__muted">
              {detection.plans.length} plan(s) conservé(s) dans brain/plans, référencés par une note
              de prompt projet.
            </p>
          ) : null}
          <button
            type="button"
            className="axe-harness__btn axe-harness__btn--primary"
            disabled={busy}
            onClick={() => void runImport()}
          >
            {busy ? "Import…" : "Importer"}
          </button>
        </div>
      ) : null}

      {report ? (
        <p className="axe-harness__muted">
          {report.created.length} entrée(s) créée(s), {report.skipped.length} ignorée(s)
          {report.errors.length ? `, ${report.errors.length} erreur(s) : ${report.errors.join(" ; ")}` : ""}.
        </p>
      ) : null}
      {error ? <p className="axe-harness__error">{error}</p> : null}
    </div>
  );
}

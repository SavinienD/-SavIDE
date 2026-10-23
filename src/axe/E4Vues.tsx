// axe:e4 — vues UI : badge « Skills synchronisées » et panneau « Exécutions ».
// Branchées sur SkillSync / ScriptSandbox ; le lecteur du dossier partagé est
// fourni par l'hôte (IPC Tauri ou API de l'espace), il n'est pas inventé ici.
import { useEffect, useState } from "react";
import type { Difference, SkillSync } from "./SkillSync";
import type { ScriptSandbox, Ticket } from "./ScriptSandbox";

export function SkillsBadge({ sync }: { sync: SkillSync }) {
  const [diff, setDiff] = useState<Difference | null>(null);
  useEffect(() => {
    const off = sync.surMiseAJour(setDiff);
    sync.demarrer();
    return () => {
      off();
      sync.arreter();
    };
  }, [sync]);
  if (!diff) return null;
  const n = diff.ajoutees.length + diff.modifiees.length + diff.retirees.length;
  return (
    <button type="button" className="skills-badge" onClick={() => setDiff(null)}
      title={[...diff.ajoutees.map((s) => `+ ${s}`), ...diff.modifiees.map((s) => `~ ${s}`), ...diff.retirees.map((s) => `- ${s}`)].join("\n")}>
      Skills synchronisées ({n})
    </button>
  );
}

export function PanneauExecutions({ sandbox }: { sandbox: ScriptSandbox }) {
  const [tickets, setTickets] = useState<Ticket[]>(() => [...sandbox.tickets.values()]);
  useEffect(() => sandbox.surChangement(() => setTickets([...sandbox.tickets.values()])), [sandbox]);
  return (
    <div className="panneau-executions" aria-label="Exécutions">
      {tickets.length === 0 ? <p>Aucune exécution.</p> : null}
      {tickets.slice().reverse().map((t) => (
        <div key={t.id} className="panneau-executions__ligne" data-etat={t.etat}>
          <code>{t.id}</code> <strong>{t.script}</strong> — {t.etat}
          {t.etat === "fini" ? <> : <code>{JSON.stringify(t.resultat)}</code></> : null}
          {t.erreur ? <> : <em>{t.erreur}</em></> : null}
        </div>
      ))}
    </div>
  );
}

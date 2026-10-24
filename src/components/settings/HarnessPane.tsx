import { useCallback, useEffect, useMemo, useState } from "react";
import { BrainImportWizard } from "./BrainImportWizard";
import {
  HARNESS_KINDS,
  formatDate,
  harnessApi,
  type HarnessEntry,
  type HarnessKind,
  type HarnessScope,
  type RefinementRecord,
} from "./harnessApi";
import { CLOUD_CONNECTION, cloudApi } from "../cloud/cloudApi"; // axe:e13
import { cloudConnectionFromPath } from "../../lib/ipc"; // axe:e13
import "./harness.css";

type Props = { workspacePath: string };
type Tab = HarnessKind | "refinements";

const OUTCOME_LABEL: Record<string, string> = {
  applied: "appliqué",
  noop: "aucun changement",
  failed: "échec",
  rolled_back: "annulé",
  running: "en cours",
  cancelled: "arrêté",
};

function modelTag(tags: string[]): string {
  return tags.find((t) => t.startsWith("model:"))?.slice(6) ?? "";
}

/** Settings > Harness: browse, edit, promote/demote entries and roll back refinements. */
/// axe:e13 — la connexion Axe Cloud, quand la session est ouverte. Le poste ne
/// garde aucun secret : c'est le service qui répond.
async function connexionCloud(): Promise<string | null> {
  try {
    const etat = await cloudApi.state();
    if (etat?.connected) return etat.connectionId || CLOUD_CONNECTION;
  } catch {
    // pas connecté à Axe Cloud : on reste sur le harnais du poste.
  }
  return null;
}

export function HarnessPane({ workspacePath }: Props) {
  const [tab, setTab] = useState<Tab>("prompt_note");
  // axe:cleanup — harness Python skills live in Settings > Skills.
  const kinds = HARNESS_KINDS.filter((kind) => kind.id !== "skill");
  const [entries, setEntries] = useState<HarnessEntry[]>([]);
  // axe:e13 — le harnais de l'espace Axe Cloud (lecture seule ici).
  const [serviceEntries, setServiceEntries] = useState<HarnessEntry[]>([]);
  const [serviceConnexion, setServiceConnexion] = useState<string | null>(null);
  const [serviceNote, setServiceNote] = useState<string | null>(null);
  const [mirrorInfo, setMirrorInfo] = useState<string | null>(null);
  const [records, setRecords] = useState<RefinementRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftBody, setDraftBody] = useState("");
  // axe:cleanup — sub-agent profile fields stored as tags (`model:provider/name`, `disabled`).
  const [draftModel, setDraftModel] = useState("");
  const [draftEnabled, setDraftEnabled] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [all, history] = await Promise.all([
        harnessApi.list(workspacePath),
        harnessApi.refinements(workspacePath),
      ]);
      setEntries(all);
      setRecords(history);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    // axe:e13 — depuis le poste, le harnais de l'espace Axe Cloud se lit aussi
    // (c'est la même source : rien à recopier, rien à synchroniser).
    if (cloudConnectionFromPath(workspacePath)) {
      // Dans l'espace lui-même, le harnais affiché EST le harnais de l'espace.
      setServiceConnexion(null);
      setServiceEntries([]);
      setServiceNote(null);
      return;
    }
    const connexion = await connexionCloud();
    setServiceConnexion(connexion);
    if (!connexion) {
      setServiceEntries([]);
      setServiceNote(null);
      return;
    }
    try {
      setServiceEntries(await harnessApi.listFrom(connexion));
      setServiceNote(null);
      // axe:shared-brain — les globales de l'espace sont injectées dans les tours
      // du poste via un miroir local, rafraîchi à chaque ouverture du panneau.
      try {
        const mirror = await harnessApi.cloudSync(connexion);
        setMirrorInfo(`${mirror.entries.length} entrée(s) globale(s) de l'espace injectées (${formatDate(mirror.fetchedAt)})`);
      } catch (e) {
        setMirrorInfo(`Miroir non rafraîchi : ${String(e)}`);
      }
    } catch (e) {
      setServiceEntries([]);
      setServiceNote(String(e));
    }
  }, [workspacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const entry of entries) map[entry.kind] = (map[entry.kind] ?? 0) + 1;
    for (const entry of serviceEntries) map[entry.kind] = (map[entry.kind] ?? 0) + 1;
    return map;
  }, [entries, serviceEntries]);

  const visible = useMemo(
    () =>
      entries
        .filter((entry) => entry.kind === tab)
        .sort((a, b) => (a.scope === b.scope ? b.updated - a.updated : a.scope === "global" ? -1 : 1)),
    [entries, tab],
  );

  // L'entrée sélectionnée peut venir du poste ou de l'espace Axe Cloud.
  const selectedFromService =
    !!selectedId && !entries.some((entry) => entry.id === selectedId);
  const selected =
    entries.find((entry) => entry.id === selectedId) ??
    serviceEntries.find((entry) => entry.id === selectedId) ??
    null;
  const visibleService = useMemo(
    () =>
      serviceEntries
        .filter((entry) => entry.kind === tab)
        .sort((a, b) => b.updated - a.updated),
    [serviceEntries, tab],
  );

  useEffect(() => {
    setDraftTitle(selected?.title ?? "");
    setDraftBody(selected?.body ?? "");
    setDraftModel(modelTag(selected?.tags ?? []));
    setDraftEnabled(!(selected?.tags ?? []).includes("disabled"));
  }, [selected?.id, selected?.updated]); // eslint-disable-line react-hooks/exhaustive-deps

  const isAgent = selected?.kind === "subagent_spec";
  const agentDirty =
    !!selected &&
    isAgent &&
    (draftModel !== modelTag(selected.tags) || draftEnabled === selected.tags.includes("disabled"));
  const dirty =
    !!selected && (draftTitle !== selected.title || draftBody !== selected.body || agentDirty);

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      await action();
      setStatus(label);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // axe:shared-brain - pousse le harnais global du poste vers l'espace.
  const publish = async () => {
    if (!serviceConnexion) return;
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const r = await harnessApi.cloudPublish(serviceConnexion);
      const msg = `Publié sur l'espace : ${r.created.length} créée(s), ${r.updated.length} mise(s) à jour, ${r.unchanged.length} inchangée(s).`;
      await reload();
      setStatus(msg);
      if (r.errors.length) setError(`Erreurs : ${r.errors.join(" ; ")}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const createEntry = (scope: HarnessScope) => {
    if (tab === "refinements") return;
    void run("Entrée créée.", async () => {
      const entry = await harnessApi.create(workspacePath, tab, scope, {
        title: tab === "subagent_spec" ? "Nouveau sous-agent" : "Nouvelle entrée",
        body: "",
        source: "user",
      });
      setSelectedId(entry.id);
    });
  };

  const save = () => {
    if (!selected) return;
    const tags = isAgent
      ? [
          ...selected.tags.filter((t) => !t.startsWith("model:") && t !== "disabled"),
          ...(draftModel.trim() ? [`model:${draftModel.trim()}`] : []),
          ...(draftEnabled ? [] : ["disabled"]),
        ]
      : undefined;
    void run("Enregistré.", () =>
      harnessApi.update(workspacePath, selected.id, { title: draftTitle, body: draftBody, tags }),
    );
  };

  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Supprimer « ${selected.title} » ?`)) return;
    void run("Supprimé.", async () => {
      await harnessApi.remove(workspacePath, selected.id);
      setSelectedId(null);
    });
  };

  const move = () => {
    if (!selected) return;
    const toGlobal = selected.scope === "project";
    void run(toGlobal ? "Promu en global." : "Dégradé en projet.", () =>
      toGlobal
        ? harnessApi.promote(workspacePath, selected.id)
        : harnessApi.demote(workspacePath, selected.id),
    );
  };

  // axe:refine-run — un affinage en cours se suit ici et peut être arrêté.
  const hasRunning = records.some((record) => record.outcome === "running");
  useEffect(() => {
    if (!hasRunning) return;
    const timer = window.setInterval(() => {
      harnessApi
        .refinements(workspacePath)
        .then(setRecords)
        .catch(() => undefined);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [hasRunning, workspacePath]);

  const stopRefinement = (record: RefinementRecord) => {
    if (!window.confirm(`Arrêter l'affinage en cours ${record.id} ?`)) return;
    void run(`Affinage ${record.id} arrêté.`, () => harnessApi.refineCancel(workspacePath, record.id));
  };

  const rollback = (record: RefinementRecord) => {
    if (!window.confirm(`Annuler l'affinage ${record.id} ?`)) return;
    void run(`Affinage ${record.id} annulé.`, () => harnessApi.rollback(workspacePath, record.id));
  };

  return (
    <div className="axe-harness">
      <header>
        <h2>Harnais</h2>
        <p className="axe-harness__muted">
          Notes, mémoires, skills et sous-agents que l'agent fait évoluer. Portée globale
          (~/.axecode/harness) ou projet (.axecode/harness). La consigne de base reste immuable.
          {serviceConnexion
            ? " Les entrées de l'espace Axe Cloud s'affichent ici aussi (lecture seule)."
            : ""}
        </p>
      </header>

      <BrainImportWizard workspacePath={workspacePath} onImported={() => void reload()} />

      <nav className="axe-harness__tabs">
        {kinds.map((kind) => (
          <button
            key={kind.id}
            type="button"
            data-active={tab === kind.id ? "true" : "false"}
            onClick={() => {
              setTab(kind.id);
              setSelectedId(null);
            }}
          >
            {kind.label} <span className="axe-harness__muted">{counts[kind.id] ?? 0}</span>
          </button>
        ))}
        <button
          type="button"
          data-active={tab === "refinements" ? "true" : "false"}
          onClick={() => setTab("refinements")}
        >
          Affinages <span className="axe-harness__muted">{records.length}</span>
        </button>
        <button
          type="button"
          data-active="false"
          title="Les skills Python du harnais sont gérés dans l'onglet Skills"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent("axecode:open-settings-section", { detail: { section: "skills" } }),
            )
          }
        >
          Skills → <span className="axe-harness__muted">{counts.skill ?? 0}</span>
        </button>
      </nav>

      {status ? <p className="axe-harness__status">{status}</p> : null}
      {error ? <p className="axe-harness__error">{error}</p> : null}
      {serviceConnexion ? (
        <div className="axe-harness__list-actions">
          <button
            type="button"
            className="axe-harness__btn"
            disabled={busy}
            title="Crée ou met à jour (même type + même titre) les entrées globales de ce poste dans le harnais global de l'espace. Rien n'est supprimé."
            onClick={() => void publish()}
          >
            Publier sur l'espace
          </button>
          {mirrorInfo ? <span className="axe-harness__muted">{mirrorInfo}</span> : null}
        </div>
      ) : null}
      {serviceNote ? (
        <p className="axe-harness__muted">
          Le harnais d'Axe Cloud n'a pas pu être lu pour l'instant.
        </p>
      ) : null}

      {tab === "refinements" ? (
        <ul className="axe-harness__records">
          {records.length === 0 ? (
            <li className="axe-harness__muted">Aucun affinage pour l'instant. Lancez /refine.</li>
          ) : null}
          {records.map((record) => (
            <li key={record.id} data-outcome={record.outcome}>
              <div className="axe-harness__record-head">
                <code>{record.id}</code>
                <span>{formatDate(record.ts)}</span>
                <span className="axe-harness__pill">{OUTCOME_LABEL[record.outcome] ?? record.outcome}</span>
                <span className="axe-harness__muted">{record.trigger}</span>
                {record.outcome === "applied" ? (
                  <button
                    type="button"
                    className="axe-harness__btn"
                    disabled={busy}
                    onClick={() => rollback(record)}
                  >
                    Annuler
                  </button>
                ) : null}
                {record.outcome === "running" ? (
                  <button
                    type="button"
                    className="axe-harness__btn"
                    disabled={busy}
                    onClick={() => stopRefinement(record)}
                  >
                    Arrêter
                  </button>
                ) : null}
              </div>
              <p>
                {record.outcome === "running"
                  ? "Affinage en préparation par le modèle…"
                  : record.outcome === "failed" && !record.summary
                    ? "L'affinage a échoué."
                    : record.summary}
              </p>
              {record.evidence.length ? (
                <details>
                  <summary>Preuves ({record.evidence.length})</summary>
                  <ul>
                    {record.evidence.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {record.diff.length ? (
                <details>
                  <summary>Fichiers ({record.diff.length})</summary>
                  <ul>
                    {record.diff.map((d) => (
                      <li key={d.path}>
                        <span className="axe-harness__pill">{d.change}</span> <code>{d.path}</code>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {record.error ? <p className="axe-harness__error">{record.error}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <div className="axe-harness__split">
          <div className="axe-harness__list">
            <div className="axe-harness__list-actions">
              <button type="button" className="axe-harness__btn" disabled={busy} onClick={() => createEntry("project")}>
                + Projet
              </button>
              <button type="button" className="axe-harness__btn" disabled={busy} onClick={() => createEntry("global")}>
                + Global
              </button>
            </div>
            {visible.length === 0 && visibleService.length === 0 ? (
              <p className="axe-harness__muted">Aucune entrée.</p>
            ) : null}
            {visible.length > 0 && visibleService.length > 0 ? (
              <div className="axe-harness__group">Ce poste</div>
            ) : null}
            {visible.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="axe-harness__row"
                data-active={entry.id === selectedId ? "true" : "false"}
                onClick={() => setSelectedId(entry.id)}
              >
                <span className="axe-harness__pill" data-scope={entry.scope}>
                  {entry.scope === "global" ? "global" : "projet"}
                </span>
                <span className="axe-harness__row-title">{entry.title}</span>
                <code className="axe-harness__muted">{entry.id}</code>
              </button>
            ))}
            {visibleService.length > 0 ? (
              <>
                <div className="axe-harness__group">
                  Espace Axe Cloud
                  <span className="axe-harness__muted">{visibleService.length}</span>
                </div>
                {visibleService.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className="axe-harness__row"
                    data-cloud="true"
                    data-active={entry.id === selectedId ? "true" : "false"}
                    onClick={() => setSelectedId(entry.id)}
                  >
                    <span
                      className="axe-harness__pill"
                      data-origin="cloud"
                      title="Entrée de l'espace Axe Cloud"
                    >
                      cloud
                    </span>
                    <span className="axe-harness__row-title">{entry.title}</span>
                    <code className="axe-harness__muted">{entry.id}</code>
                  </button>
                ))}
              </>
            ) : null}
          </div>

          <div className="axe-harness__detail">
            {selected ? (
              <>
                {selectedFromService ? (
                  <p className="axe-harness__origin">
                    Entrée de l'espace <strong>Axe Cloud</strong> — lecture seule ici. Elle
                    s'écrit depuis l'espace (« Revenir à Axe Cloud ») : rien à recopier sur
                    le poste, c'est la même source.
                  </p>
                ) : null}
                <input
                  className="axe-harness__title"
                  value={draftTitle}
                  readOnly={selectedFromService}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  aria-label="Titre"
                />
                <div className="axe-harness__meta axe-harness__muted">
                  <code>{selected.id}</code> · source {selected.source || "—"} · modifié{" "}
                  {formatDate(selected.updated)}
                </div>
                {isAgent ? (
                  <div className="axe-harness__agent">
                    <label>
                      Modèle
                      <input
                        value={draftModel}
                        onChange={(e) => setDraftModel(e.target.value)}
                        placeholder="fournisseur/modèle (vide = modèle de la session)"
                        spellCheck={false}
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={draftEnabled}
                        onChange={(e) => setDraftEnabled(e.target.checked)}
                      />
                      Activé — utilisable via <code>rlm(profile="{selected.title}")</code>
                    </label>
                  </div>
                ) : null}
                <textarea
                  className="axe-harness__body"
                  value={draftBody}
                  readOnly={selectedFromService}
                  onChange={(e) => setDraftBody(e.target.value)}
                  spellCheck={false}
                  aria-label="Contenu"
                />
                {selected.evidence.length ? (
                  <details>
                    <summary>Preuves ({selected.evidence.length})</summary>
                    <ul>
                      {selected.evidence.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                <p className="axe-harness__muted">
                  <code>{selected.packageDir ?? selected.path}</code>
                </p>
                {selectedFromService ? null : (
                  <div className="axe-harness__actions">
                    <button
                      type="button"
                      className="axe-harness__btn axe-harness__btn--primary"
                      disabled={!dirty || busy}
                      onClick={save}
                    >
                      Enregistrer
                    </button>
                    <button type="button" className="axe-harness__btn" disabled={busy} onClick={move}>
                      {selected.scope === "project" ? "Promouvoir en global" : "Dégrader en projet"}
                    </button>
                    <button type="button" className="axe-harness__btn axe-harness__btn--danger" disabled={busy} onClick={remove}>
                      Supprimer
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="axe-harness__muted">Sélectionnez une entrée.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

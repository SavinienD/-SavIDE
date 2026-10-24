// Typed IPC wrappers for the Continual Harness (`harness_*` Tauri commands).
import { invoke } from "@tauri-apps/api/core";
import { cloudConnectionFromPath, cloudRpc } from "../../lib/ipc";

/// axe:v2-l2.4 — operations du harnais sans RPC daemon : refus explicite en cloud
/// (sinon elles ecriraient un dossier local `axe-cloud:/...` sur le poste).
function cloudUnsupported(workspacePath: string, action: string): Promise<never> | null {
  if (!cloudConnectionFromPath(workspacePath)) return null;
  return Promise.reject(
    new Error(`${action} n'est pas encore disponible sur un espace de travail cloud.`),
  );
}

export type HarnessKind = "prompt_note" | "memory" | "skill" | "subagent_spec";
export type HarnessScope = "global" | "project";

export const HARNESS_KINDS: { id: HarnessKind; label: string }[] = [
  { id: "prompt_note", label: "Notes de prompt" },
  { id: "memory", label: "Mémoires" },
  { id: "skill", label: "Skills" },
  { id: "subagent_spec", label: "Sous-agents" },
];

export type HarnessEntry = {
  id: string;
  kind: HarnessKind;
  scope: HarnessScope;
  title: string;
  created: number;
  updated: number;
  source: string;
  evidence: string[];
  tags: string[];
  body: string;
  path: string;
  packageDir?: string;
};

export type HarnessNewEntry = {
  title: string;
  body: string;
  source?: string;
  evidence?: string[];
  tags?: string[];
  code?: string;
};

export type HarnessPatch = Partial<Omit<HarnessNewEntry, "source">> & { source?: string };

export type RefineOutcome = "applied" | "noop" | "failed" | "rolled_back" | "running" | "cancelled";

export type RefinementRecord = {
  id: string;
  ts: number;
  scope: HarnessScope;
  trigger: string;
  focus?: string;
  conversationId?: string;
  summary: string;
  evidence: string[];
  operations: { op: string; kind?: HarnessKind; id?: string; title?: string; reason?: string }[];
  diff: { path: string; change: string; beforeExcerpt?: string; afterExcerpt?: string }[];
  outcome: RefineOutcome;
  error?: string;
  touchedIds: string[];
  rolledBackAt?: number;
};

export type BrainItem = {
  relativePath: string;
  kind: HarnessKind;
  scope: HarnessScope;
  scopeChoice: boolean;
  title: string;
  bytes: number;
  alreadyImported: boolean;
};

export type BrainDetection = {
  found: boolean;
  brainDir: string;
  items: BrainItem[];
  plans: string[];
  agentsMdObsolete: boolean;
};

export type BrainImportOptions = { memoryScope?: HarnessScope; exclude?: string[] };
/// axe:shared-brain — miroir local du harnais global de l'espace (injecté à chaque tour).
export type CloudMirror = { connection: string; fetchedAt: number; entries: HarnessEntry[] };
export type PublishReport = { created: string[]; updated: string[]; unchanged: string[]; errors: string[] };
export type BrainImportReport = { created: string[]; skipped: string[]; errors: string[] };

export const harnessApi = {
  paths: (workspacePath: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudRpc<{ globalRoot: string; projectRoot: string }>(conn, "harness.paths", {});
    }
    return invoke<{ globalRoot: string; projectRoot: string }>("harness_paths", { workspacePath });
  },
  list: (workspacePath: string, kind?: HarnessKind, scope?: HarnessScope) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry[]>(conn, "harness.list", { kind, scope });
    return invoke<HarnessEntry[]>("harness_list", { input: { workspacePath, kind, scope } });
  },
  /// axe:e13 — lit le harnais d'un espace Axe Cloud depuis l'interface
  /// classique (volet Réglages > Harnais) : lecture seule, l'écriture reste
  /// dans l'espace, donc rien n'est recopié sur le poste.
  listFrom: (connection: string, kind?: HarnessKind, scope?: HarnessScope) =>
    cloudRpc<HarnessEntry[]>(connection, "harness.list", { kind, scope }),
  get: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry | null>(conn, "harness.get", { id });
    return invoke<HarnessEntry | null>("harness_get", { input: { workspacePath, id } });
  },
  create: (workspacePath: string, kind: HarnessKind, scope: HarnessScope, entry: HarnessNewEntry) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry>(conn, "harness.create", { kind, scope, entry });
    return invoke<HarnessEntry>("harness_create", { input: { workspacePath, kind, scope, entry } });
  },
  update: (workspacePath: string, id: string, patch: HarnessPatch) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry>(conn, "harness.update", { id, patch });
    return invoke<HarnessEntry>("harness_update", { input: { workspacePath, id, patch } });
  },
  remove: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry>(conn, "harness.delete", { id });
    return invoke<HarnessEntry>("harness_delete", { input: { workspacePath, id } });
  },
  promote: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry>(conn, "harness.promote", { id });
    return invoke<HarnessEntry>("harness_promote", { input: { workspacePath, id } });
  },
  demote: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<HarnessEntry>(conn, "harness.demote", { id });
    return invoke<HarnessEntry>("harness_demote", { input: { workspacePath, id } });
  },
  refinements: (workspacePath: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<RefinementRecord[]>(conn, "harness.refinements", {});
    return invoke<RefinementRecord[]>("harness_refinements", { workspacePath });
  },
  rollback: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<RefinementRecord>(conn, "harness.rollback", { id });
    return invoke<RefinementRecord>("harness_rollback", { input: { workspacePath, id } });
  },
  // axe:refine-run — stop a running refinement.
  refineCancel: (workspacePath: string, id: string) => {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<RefinementRecord>(conn, "harness.refine_cancel", { id });
    return invoke<RefinementRecord>("harness_refine_cancel", { input: { workspacePath, id } });
  },
  brainDetect: (workspacePath: string, options: BrainImportOptions = {}) =>
    cloudUnsupported(workspacePath, "L'import du cerveau") ??
    invoke<BrainDetection>("harness_brain_detect", { input: { workspacePath, options } }),
  brainImport: (workspacePath: string, options: BrainImportOptions) =>
    cloudUnsupported(workspacePath, "L'import du cerveau") ??
    invoke<BrainImportReport>("harness_brain_import", { input: { workspacePath, options } }),
  cloudSync: (connection: string) =>
    invoke<CloudMirror>("harness_cloud_sync", { input: { connection } }),
  cloudStatus: () => invoke<CloudMirror>("harness_cloud_status"),
  cloudPublish: (connection: string) =>
    invoke<PublishReport>("harness_cloud_publish", { input: { connection } }),
  refineStart: (workspacePath: string, conversationId: string, focus?: string) =>
    cloudUnsupported(workspacePath, "/refine") ??
    invoke<boolean>("harness_refine_start", { input: { workspacePath, conversationId, focus } }),
  refineStatus: (workspacePath: string, conversationId: string) =>
    cloudUnsupported(workspacePath, "/refine") ??
    invoke<{ pending?: { recordId: string; state: "planning" | "done" | "failed"; focus?: string; error?: string; record?: RefinementRecord }; recent: RefinementRecord[] }>(
      "harness_refine_status",
      { input: { workspacePath, conversationId } },
    ),
};

export function formatDate(ms: number): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

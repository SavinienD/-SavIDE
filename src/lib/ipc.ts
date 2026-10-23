import { invoke } from "@tauri-apps/api/core";
import type {
  AttachmentInput,
  ActiveTurnReplay,
  ActiveTurnSummary,
  AgentMode,
  AnthropicProviderStatus,
  ChatMessage,
  ClipboardImageAttachment,
  ContextEstimate,
  ConversationSummary,
  RemoteStatus,
  RewriteWorkspaceRestoreCheck,
  FileDocument,
  GitBranch,
  GitCreateWorktreeOutput,
  GitOperationResult,
  GitPullRequestOutput,
  GitRepositorySnapshot,
  GitStatusFile,
  GitWorktree,
  GoogleProviderStatus,
  InstalledSkill,
  KimiProviderStatus,
  MessageVisibility,
  McpOAuthStatus,
  McpServerProbe,
  McpSettings,
  ModeModelSettings,
  ModelRef,
  OpenAiProviderStatus,
  OpenRouterModel,
  OpenRouterModelSearchResult,
  OpenRouterProviderStatus,
  Part,
  PlanControl,
  QuestionAnswer,
  SavedConversation,
  ServiceTier,
  SkillSettings,
  StartAnthropicLoginOutput,
  StartGoogleLoginOutput,
  StartKimiLoginOutput,
  StartMcpOAuthLoginOutput,
  StartOpenAiLoginOutput,
  TerminalCommandResult,
  TerminalPathResolution,
  TerminalSpawnResult,
  ThinkingLevel,
  ToolResultImage,
  ToolSettings,
  UpdateInfo,
  WorkspaceBootstrap,
  WorkspaceDeletedEntry,
  WorkspaceEntry,
  WorkspaceSearchResult,
} from "../types";
import {
  CloudOfflineError,
  assertCloudWritable,
  isCloudOffline,
  isCloudTransportError,
  markCloudOffline,
  markCloudOnline,
} from "./cloudOnline"; // axe:v2-l6
import {
  createOfflineDirectory,
  createOfflineFile,
  deleteOfflineEntry,
  listOfflineEntries,
  listOfflineIndex,
  readOfflineFile,
  renameOfflineEntry,
  writeOfflineFile,
} from "./cloudOffline"; // axe:v2-l6 (tranche 2)
import { ouvertureEspace } from "./ouvertureEspace"; // axe:parcours-collegue

/// axe:v2-l2.3 — un espace de travail CLOUD porte sa connexion dans son identifiant
/// (`axe-cloud://<connexion><racine>`) : aucun etat global a interroger, l'IDE sait toujours ou il ecrit.
export const CLOUD_WORKSPACE_PREFIX = "axe-cloud://";

export function cloudConnectionFromPath(workspacePath: string): string | null {
  if (!workspacePath || !workspacePath.startsWith(CLOUD_WORKSPACE_PREFIX)) return null;
  const connexion = workspacePath
    .slice(CLOUD_WORKSPACE_PREFIX.length)
    .split("/")[0]
    ?.trim();
  return connexion || null;
}

/// axe:cloud-sous-dossier — `axe-cloud://<connexion>/<racine>/<sous/dossier>` : le service ne
/// connait que sa racine (`fs.*` relatifs a /work). Ces aides prefixent les chemins envoyes
/// par le sous-dossier ouvert depuis l'accueil et le retirent des chemins recus.
export function cloudSubdirFromPath(workspacePath: string): string {
  if (!workspacePath || !workspacePath.startsWith(CLOUD_WORKSPACE_PREFIX)) return "";
  const segments = workspacePath
    .slice(CLOUD_WORKSPACE_PREFIX.length)
    .split("/")
    .filter(Boolean);
  // [connexion, racine, ...sous-dossier]
  return segments.slice(2).join("/");
}

export function cloudToService(workspacePath: string, relativePath: string): string;
export function cloudToService(workspacePath: string, relativePath: string | null | undefined): string | null;
export function cloudToService(workspacePath: string, relativePath: string | null | undefined): string | null {
  const sub = cloudSubdirFromPath(workspacePath);
  const clean = (relativePath ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!sub) return relativePath ?? null;
  return clean ? `${sub}/${clean}` : sub;
}

export function cloudFromService(workspacePath: string, servicePath: string): string {
  const sub = cloudSubdirFromPath(workspacePath);
  if (!sub || typeof servicePath !== "string") return servicePath;
  const clean = servicePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean === sub) return "";
  return clean.startsWith(`${sub}/`) ? clean.slice(sub.length + 1) : clean;
}

function cloudInSubdir(workspacePath: string, servicePath: string): boolean {
  const sub = cloudSubdirFromPath(workspacePath);
  if (!sub) return true;
  const clean = (servicePath ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  return clean === sub || clean.startsWith(`${sub}/`);
}

function cloudStripRel<T>(workspacePath: string, value: T): T {
  if (!cloudSubdirFromPath(workspacePath) || !value || typeof value !== "object") return value;
  const v = value as unknown as { relativePath?: unknown };
  if (typeof v.relativePath !== "string") return value;
  return { ...(value as object), relativePath: cloudFromService(workspacePath, v.relativePath) } as T;
}

/// axe:v2-l2.4 — appel direct d'une methode du daemon sur une connexion cloud.
/// axe:v2-l6 — alimente l'etat de joignabilite : un succes (ou une erreur
/// metier renvoyee par le service) = en ligne, un echec de transport = hors ligne.
export async function cloudRpc<T>(connection: string, method: string, params: unknown = {}): Promise<T> {
  try {
    const result = await invoke<T>("daemon_call", { input: { connection, method, params } });
    markCloudOnline(connection);
    return result;
  } catch (err) {
    if (isCloudTransportError(err)) {
      markCloudOffline(connection);
    } else {
      markCloudOnline(connection);
    }
    throw err;
  }
}

/// axe:v2-l6 — ecriture cloud : refusee d'emblee hors ligne, et echec de
/// transport traduit en message court plutot qu'en erreur brute.
async function cloudWriteRpc<T>(
  connection: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  assertCloudWritable(connection);
  try {
    return await cloudRpc<T>(connection, method, params);
  } catch (err) {
    if (isCloudTransportError(err)) throw new CloudOfflineError();
    throw err;
  }
}

/// axe:v2-l6 — meme garde pour les commandes Tauri d'ecriture dediees.
async function cloudWrite<T>(connection: string, run: () => Promise<T>): Promise<T> {
  assertCloudWritable(connection);
  try {
    const result = await run();
    markCloudOnline(connection);
    return result;
  } catch (err) {
    if (isCloudTransportError(err)) {
      markCloudOffline(connection);
      throw new CloudOfflineError();
    }
    throw err;
  }
}

/// axe:v2-l6 (tranche 2) — lecture cloud : hors ligne (ou transport rompu en
/// cours de route) on repond depuis la copie locale (miroir).
async function cloudRead<T>(
  connection: string,
  run: () => Promise<T>,
  offline: () => Promise<T>,
): Promise<T> {
  if (isCloudOffline(connection)) return offline();
  try {
    const result = await run();
    markCloudOnline(connection);
    return result;
  } catch (err) {
    if (isCloudTransportError(err)) {
      markCloudOffline(connection);
      return offline();
    }
    throw err;
  }
}

/// axe:v2-l6 (tranche 2) — ecriture cloud : hors ligne (ou transport rompu) la
/// modification part dans le miroir et reste en attente de synchronisation.
async function cloudWriteMirrored<T>(
  connection: string,
  run: () => Promise<T>,
  offline: () => Promise<T>,
): Promise<T> {
  if (isCloudOffline(connection)) return offline();
  try {
    const result = await run();
    markCloudOnline(connection);
    return result;
  } catch (err) {
    if (isCloudTransportError(err)) {
      markCloudOffline(connection);
      return offline();
    }
    throw err;
  }
}

/// axe:v2-l2.4 — nom d'un skill deduit de son chemin (`.../<nom>/SKILL.md`).
function skillNameFromPath(path: string): string {
  const segments = path.split(/[\\/]+/).filter(Boolean);
  const file = segments.pop() ?? "";
  if (file.toLowerCase() === "skill.md") return segments.pop() ?? "";
  return file.replace(/\.md$/i, "");
}

/// axe:v2-l2.4 — valeur d'un champ du frontmatter YAML (name/description).
function skillFrontmatterValue(content: string, key: string): string | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatter) return null;
  const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(frontmatter[1]);
  const value = line?.[1]?.trim();
  if (!value) return null;
  return value.replace(/^["']|["']$/g, "").trim() || null;
}

/// axe:v2-l2.4 — nom libre pour un nouveau skill (`new-skill`, `new-skill-1`, ...).
function nextSkillName(skills: InstalledSkill[]): string {
  const taken = new Set(skills.map((skill) => skill.name));
  if (!taken.has("new-skill")) return "new-skill";
  let index = 1;
  while (taken.has(`new-skill-${index}`)) index += 1;
  return `new-skill-${index}`;
}

/// axe:v2-l2.4 — contenu initial identique au modele local.
function newSkillContent(name: string): string {
  return `---\nname: ${name}\ndescription: Décrivez à quoi sert ce skill\n---\n\n# ${name}\n\nÉcrivez les consignes que l'agent doit suivre quand ce skill est activé.\n`;
}

/// Dernier depot Git vu par l'explorateur cloud (cle = connexion).
const cloudRepoByConnection = new Map<string, string>();

/// Lit la sortie `git status --short --branch` du daemon.
function parseCloudGitStatus(output: string): GitStatusFile[] {
  const files: GitStatusFile[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4 || line.startsWith("##")) continue;
    const index = line.slice(0, 1);
    const worktree = line.slice(1, 2);
    const path = (line.slice(3).split(" -> ").pop() ?? "").trim();
    if (!path) continue;
    files.push({
      path,
      indexStatus: index,
      worktreeStatus: worktree,
      kind: index === "?" ? "untracked" : "modified",
      staged: index !== " " && index !== "?",
    });
  }
  return files;
}

/// Instantane Git de l'espace cloud : premier depot de la racine (les projets sont des depots,
/// la racine de l'espace ne l'est pas).
async function cloudGitSnapshot(connection: string): Promise<GitRepositorySnapshot> {
  const vide: GitRepositorySnapshot = {
    gitAvailable: true,
    ghAvailable: false,
    isRepository: false,
    workspacePath: "",
    dirtyCount: 0,
    status: [],
    worktrees: [],
    branches: [],
  };
  try {
    const repos = await invoke<{ path: string; name: string; isRepo: boolean }[]>("remote_git_repos", {
      input: { connectionId: connection },
    });
    const repo = repos.find((entree) => entree.isRepo);
    if (!repo) return vide;
    cloudRepoByConnection.set(connection, repo.path);
    const res = await invoke<{ output: string; repoPath?: string }>("remote_git_status", {
      input: { connectionId: connection, repo: repo.path },
    });
    const status = parseCloudGitStatus(res.output ?? "");
    const currentBranch = /^##\s+([^\s.]+)/.exec(res.output ?? "")?.[1] ?? null;
    // axe:v2-l2.4b — branches et worktrees du service (sections du panneau Git).
    let branches: GitBranch[] = [];
    let worktrees: GitWorktree[] = [];
    try {
      const b = await cloudRpc<CloudGitBranches>(connection, "git.branches", {
        repoPath: repo.path,
      });
      branches = cloudBranches(b);
    } catch {
      // service sans git.branches : la section reste vide.
    }
    try {
      const w = await cloudRpc<CloudGitWorktree[]>(connection, "git.worktrees", {
        repoPath: repo.path,
      });
      worktrees = cloudWorktrees(repo.path, currentBranch, w);
    } catch {
      // service sans git.worktrees : la section reste vide.
    }
    return {
      ...vide,
      isRepository: true,
      repoRoot: res.repoPath ?? repo.path,
      currentBranch,
      dirtyCount: status.length,
      status,
      branches,
      worktrees,
    };
  } catch {
    return vide;
  }
}

/// Depot vise (chemin relatif a l'espace) pour une connexion cloud.
async function cloudRepoFor(connection: string): Promise<string> {
  const connu = cloudRepoByConnection.get(connection);
  if (connu) return connu;
  try {
    const repos = await invoke<{ path: string; name: string; isRepo: boolean }[]>("remote_git_repos", {
      input: { connectionId: connection },
    });
    const repo = repos.find((entree) => entree.isRepo);
    if (repo) cloudRepoByConnection.set(connection, repo.path);
    return repo?.path ?? "";
  } catch {
    return "";
  }
}

/// axe:v2-l2.4b — element de la corbeille du service.
export type CloudTrashEntry = {
  id: string;
  path: string;
  name: string;
  trashedAtMs: number;
};

/// axe:v2-l2.4b — entree d'index cloud : meme forme que `list_workspace_files_command`.
function cloudFileEntry(workspacePath: string, relativePath: string): WorkspaceEntry {
  const clean = relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const segments = clean.split("/").filter(Boolean);
  return {
    name: segments[segments.length - 1] ?? clean,
    relativePath: clean,
    absolutePath: `${workspacePath.replace(/\/+$/, "")}/${clean}`,
    kind: "file",
    hasChildren: false,
  };
}

/// axe:v2-l2.4b — reponses du service pour les operations Git.
type CloudGitBranches = {
  current?: string | null;
  branches?: { name: string; current?: boolean; upstream?: string | null }[];
};

type CloudGitWorktree = {
  path: string;
  branch?: string | null;
  head?: string | null;
};

type CloudGitOperation = { ok?: boolean; output?: string };

/// Meme forme que `GitOperationResult` (les commandes locales).
function cloudGitResult(message: string, res: CloudGitOperation): GitOperationResult {
  return { message, stdout: res?.output ?? null, stderr: null };
}

/// Meme forme que `snapshot.branches` (le service ne renvoie que le local).
function cloudBranches(res: CloudGitBranches): GitBranch[] {
  return (res?.branches ?? []).map((branch) => ({
    name: branch.name,
    kind: "local",
    current: Boolean(branch.current) || branch.name === res?.current,
    upstream: branch.upstream ?? null,
  }));
}

/// Meme forme que `snapshot.worktrees`.
function cloudWorktrees(
  repoPath: string,
  currentBranch: string | null,
  list: CloudGitWorktree[],
): GitWorktree[] {
  return (list ?? []).map((worktree) => {
    const segments = worktree.path.split("/").filter(Boolean);
    return {
      name: segments[segments.length - 1] ?? worktree.path,
      path: worktree.path,
      branch: worktree.branch ?? null,
      head: worktree.head ?? null,
      isCurrent:
        worktree.path === repoPath ||
        (Boolean(worktree.branch) && worktree.branch === currentBranch),
      dirty: false,
      dirtyCount: 0,
    };
  });
}

/// axe:v2-l2.4b — corbeille du service. Le mode local restaure par lot
/// (Ctrl+Z dans l'explorateur), il n'a pas de liste persistante.
export async function listTrash(workspacePath: string): Promise<CloudTrashEntry[]> {
  const conn = cloudConnectionFromPath(workspacePath);
  if (!conn) return [];
  return cloudRpc<CloudTrashEntry[]>(conn, "fs.trash_list", {});
}

/// axe:v2-l2.4b — restaure une entree de corbeille cloud par son identifiant.
export async function restoreFromTrash(
  workspacePath: string,
  id: string,
): Promise<WorkspaceEntry | null> {
  const conn = cloudConnectionFromPath(workspacePath);
  if (!conn) return null;
  const res = await cloudWriteRpc<{ path?: string }>(conn, "fs.restore", { id });
  return cloudFileEntry(workspacePath, res?.path ?? "");
}

/// axe:v2-l7 — une session du service (meme forme que `SessionMeta` de l'API Agents).
type CloudSessionMeta = {
  id?: unknown;
  name?: unknown;
  model?: unknown;
  updatedAtMs?: unknown;
  createdAtMs?: unknown;
  archived?: unknown;
};

/// axe:v2-l7 — modele du service (`{ provider, name }`), jamais invente : les
/// champs manquants restent vides.
function cloudModel(raw: unknown): ModelRef {
  const model = (raw ?? {}) as { provider?: unknown; name?: unknown };
  return {
    provider: typeof model.provider === "string" ? model.provider : "",
    name: typeof model.name === "string" ? model.name : "",
  };
}

/// axe:v2-l7 — convertit une part du service ; un type inconnu est ignore proprement.
function cloudPart(raw: unknown): Part | null {
  if (!raw || typeof raw !== "object") return null;
  const part = raw as Record<string, unknown>;
  const meta = (part.meta as Record<string, unknown> | null | undefined) ?? null;
  switch (part.type) {
    case "text":
      return { type: "text", text: String(part.text ?? ""), meta };
    case "thinking":
      return { type: "thinking", text: String(part.text ?? ""), meta };
    case "image":
      return {
        type: "image",
        media_type: String(part.media_type ?? ""),
        data: String(part.data ?? ""),
        meta,
      };
    case "tool_call":
      return {
        type: "tool_call",
        id: String(part.id ?? ""),
        name: String(part.name ?? ""),
        input: part.input,
        meta,
      };
    case "tool_result":
      return {
        type: "tool_result",
        tool_call_id: String(part.tool_call_id ?? ""),
        content: String(part.content ?? ""),
        images: Array.isArray(part.images) ? (part.images as ToolResultImage[]) : undefined,
        is_error: Boolean(part.is_error),
        meta,
      };
    default:
      return null;
  }
}

/// axe:v2-l7 — convertit un message du service ; role inconnu ignore proprement.
function cloudChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const message = raw as { role?: unknown; parts?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return null;
  const parts = (Array.isArray(message.parts) ? message.parts : [])
    .map(cloudPart)
    .filter((part): part is Part => part !== null);
  return { role: message.role, parts };
}

/// axe:v2-l7 — `ConversationSummary` a partir des sessions du service (tri recent -> ancien,
/// sessions archivees ignorees).
function cloudConversationSummaries(sessions: CloudSessionMeta[]): ConversationSummary[] {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s.id === "string" && !s.archived)
    .map((s) => ({
      id: s.id as string,
      title: typeof s.name === "string" ? s.name : "",
      updatedAtMs:
        typeof s.updatedAtMs === "number"
          ? s.updatedAtMs
          : typeof s.createdAtMs === "number"
            ? s.createdAtMs
            : 0,
    }))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs);
}

/// axe:v2-l7 — liste des conversations du service (seules a exister en cloud).
async function cloudListConversations(connection: string): Promise<ConversationSummary[]> {
  const sessions = await cloudRpc<CloudSessionMeta[]>(connection, "sessions.list", {});
  return cloudConversationSummaries(sessions);
}

/// axe:e3 — conversations rangées dans l'archive. Le service est le seul à
/// savoir où elles sont : il ne renvoie que des métadonnées, jamais un chemin.
async function cloudListArchivedConversations(
  connection: string,
): Promise<ConversationSummary[]> {
  const sessions = await cloudRpc<CloudSessionMeta[]>(
    connection,
    "sessions.list",
    { archived: true },
  );
  return cloudConversationSummaries(sessions).map((conversation) => ({
    ...conversation,
    archived: true,
  }));
}

/// axe:v2-l7 — conversation du service : historique par `sessions.history`, metadonnees
/// par `sessions.get` (titre, modele). Rien n'est invente : sans meta, titre et modele vides.
async function cloudLoadConversation(
  connection: string,
  workspacePath: string,
  conversationId: string,
): Promise<SavedConversation> {
  const [rawHistory, meta] = await Promise.all([
    cloudRpc<unknown[]>(connection, "sessions.history", { sessionId: conversationId }),
    cloudRpc<CloudSessionMeta>(connection, "sessions.get", { sessionId: conversationId }).catch(
      () => null,
    ),
  ]);
  const history = (Array.isArray(rawHistory) ? rawHistory : [])
    .map(cloudChatMessage)
    .filter((message): message is ChatMessage => message !== null);
  const model = cloudModel(meta?.model);
  return {
    id: conversationId,
    workspaceId: workspacePath,
    title: typeof meta?.name === "string" ? meta.name : "",
    model,
    modeModelSettings: { act: model, plan: model, goal: model },
    systemPrompt: "",
    planWorkflow: { status: "idle" },
    goalWorkflow: { status: "idle" },
    history,
  };
}

export const api = {
  openWorkspace(workspacePath: string) {
    return invoke<WorkspaceBootstrap>("open_workspace", {
      input: { workspacePath },
    });
  },
  /// axe:v2-l2.3 — ouvre l'IDE sur l'espace cloud (fichiers sur la VM, aucun dossier local).
  /// axe:parcours-collegue (D5) — liste des conversations de l'espace (sessions.list), pas du PC.
  async openCloudWorkspace(connectionId: string, folder?: string) {
    const bootstrap = await invoke<WorkspaceBootstrap>("open_cloud_workspace", {
      input: { connectionId, folder: folder ?? null },
    });
    return ouvertureEspace(bootstrap, () =>
      cloudListConversations(cloudConnectionFromPath(bootstrap.workspace.path) ?? connectionId),
    );
  },
  async gitSnapshot(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudGitSnapshot(conn);
    return invoke<GitRepositorySnapshot>("git_repository_snapshot_command", {
      input: { workspacePath },
    });
  },
  gitInit(workspacePath: string) {
    return invoke<GitRepositorySnapshot>("git_init_command", {
      input: { workspacePath },
    });
  },
  gitCreateWorktree(
    workspacePath: string,
    branchName: string,
    baseBranch: string | null,
    pushImmediately: boolean,
  ) {
    return invoke<GitCreateWorktreeOutput>("git_create_worktree_command", {
      input: { workspacePath, branchName, baseBranch, pushImmediately },
    });
  },
  gitRemoveWorktree(workspacePath: string, targetPath: string, force: boolean) {
    return invoke<GitOperationResult>("git_remove_worktree_command", {
      input: { workspacePath, targetPath, force },
    });
  },
  gitCreateBranch(
    workspacePath: string,
    branchName: string,
    baseBranch: string | null,
  ) {
    return invoke<GitOperationResult>("git_create_branch_command", {
      input: { workspacePath, branchName, baseBranch },
    });
  },
  gitDeleteBranch(
    workspacePath: string,
    branchName: string,
    force: boolean,
    deleteRemote: boolean,
  ) {
    return invoke<GitOperationResult>("git_delete_branch_command", {
      input: { workspacePath, branchName, force, deleteRemote },
    });
  },
  gitRenameBranch(
    workspacePath: string,
    oldName: string,
    newName: string,
    syncRemote: boolean,
  ) {
    return invoke<GitOperationResult>("git_rename_branch_command", {
      input: { workspacePath, oldName, newName, syncRemote },
    });
  },
  async gitCommit(workspacePath: string, message: string, paths: string[]) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      // Le daemon attend des chemins depuis la racine de l'espace + le depot vise.
      const repo = await cloudRepoFor(conn);
      const cibles = repo
        ? paths.map((chemin) => (chemin.startsWith(`${repo}/`) ? chemin : `${repo}/${chemin}`))
        : paths;
      return cloudWrite(conn, () =>
        invoke<GitOperationResult>("remote_git_commit", {
          input: { connectionId: conn, message, paths: cibles, repo: repo || null },
        }),
      );
    }
    return invoke<GitOperationResult>("git_commit_command", {
      input: { workspacePath, message, paths },
    });
  },
  async gitPush(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      const repo = await cloudRepoFor(conn);
      const res = await cloudWriteRpc<CloudGitOperation>(conn, "git.push", { repoPath: repo });
      return cloudGitResult("Poussé vers le dépôt distant.", res);
    }
    return invoke<GitOperationResult>("git_push_command", {
      input: { workspacePath },
    });
  },
  async gitPull(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      const repo = await cloudRepoFor(conn);
      const res = await cloudWriteRpc<CloudGitOperation>(conn, "git.pull", { repoPath: repo });
      return cloudGitResult("Récupéré depuis le dépôt distant.", res);
    }
    return invoke<GitOperationResult>("git_pull_command", {
      input: { workspacePath },
    });
  },
  async gitBranches(workspacePath: string): Promise<GitBranch[]> {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      const repo = await cloudRepoFor(conn);
      const res = await cloudRpc<CloudGitBranches>(conn, "git.branches", { repoPath: repo });
      return cloudBranches(res);
    }
    const snapshot = await invoke<GitRepositorySnapshot>(
      "git_repository_snapshot_command",
      { input: { workspacePath } },
    );
    return snapshot.branches;
  },
  async gitCheckout(
    workspacePath: string,
    branch: string,
    create = false,
  ): Promise<GitOperationResult> {
    const conn = cloudConnectionFromPath(workspacePath);
    if (!conn) {
      throw new Error("Le changement de branche n'est pas encore possible dans un espace de travail local.");
    }
    const repo = await cloudRepoFor(conn);
    const res = await cloudWriteRpc<{ branch?: string }>(conn, "git.checkout", {
      repoPath: repo,
      branch,
      create,
    });
    const name = res?.branch || branch;
    return {
      message: create ? `Branche ${name} créée et extraite.` : `Branche ${name} extraite.`,
      stdout: null,
      stderr: null,
    };
  },
  async gitWorktrees(workspacePath: string): Promise<GitWorktree[]> {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      const repo = await cloudRepoFor(conn);
      const list = await cloudRpc<CloudGitWorktree[]>(conn, "git.worktrees", {
        repoPath: repo,
      });
      return cloudWorktrees(repo, null, list);
    }
    const snapshot = await invoke<GitRepositorySnapshot>(
      "git_repository_snapshot_command",
      { input: { workspacePath } },
    );
    return snapshot.worktrees;
  },
  gitCreatePullRequest(
    workspacePath: string,
    title: string,
    body: string,
    targetBranch: string,
  ) {
    return invoke<GitPullRequestOutput>("git_create_pull_request_command", {
      input: { workspacePath, title, body, targetBranch },
    });
  },
  openNewWindow() {
    return invoke<void>("open_new_window");
  },
  resetWindowTitle() {
    return invoke<void>("reset_window_title");
  },
  watchWorkspace(workspacePath: string) {
    if (cloudConnectionFromPath(workspacePath)) return Promise.resolve();
    return invoke<void>("watch_workspace_command", {
      input: { workspacePath },
    });
  },
  unwatchWorkspace(workspacePath: string) {
    if (cloudConnectionFromPath(workspacePath)) return Promise.resolve(true);
    return invoke<boolean>("unwatch_workspace_command", {
      input: { workspacePath },
    });
  },
  listEntries(workspacePath: string, relativePath?: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudRead<WorkspaceEntry[]>(
        conn,
        () =>
          invoke<WorkspaceEntry[]>("remote_workspace_entries", {
            input: { connectionId: conn, relativePath: cloudToService(workspacePath, relativePath) ?? null },
          }).then((list) => (list ?? []).map((e) => cloudStripRel(workspacePath, e))),
        () => listOfflineEntries(workspacePath, relativePath),
      );
    }
    return invoke<WorkspaceEntry[]>("list_workspace_entries_command", {
      input: { workspacePath, relativePath },
    });
  },
  async listAllFiles(workspacePath: string) {
    // axe:v2-l2.4b — l'index « ouvrir vite » vient de fs.index cote service.
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      // axe:v2-l6 — hors ligne : l'index du miroir fait office d'index.
      return cloudRead<WorkspaceEntry[]>(
        conn,
        async () => {
          const index = await cloudRpc<{ paths?: string[]; truncated?: boolean }>(
            conn,
            "fs.index",
            {},
          );
          return (index?.paths ?? [])
            .filter((path) => cloudInSubdir(workspacePath, path))
            .map((path) => cloudFileEntry(workspacePath, cloudFromService(workspacePath, path)));
        },
        () => listOfflineIndex(workspacePath),
      );
    }
    return invoke<WorkspaceEntry[]>("list_workspace_files_command", {
      input: { workspacePath },
    });
  },
  searchWorkspace(workspacePath: string, query: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return invoke<WorkspaceSearchResult>("remote_workspace_search", {
        input: { connectionId: conn, query },
      }).then((res) => {
        const r = res as unknown as { files?: { relativePath?: string }[] };
        if (!cloudSubdirFromPath(workspacePath) || !Array.isArray(r?.files)) return res;
        return {
          ...(res as object),
          files: r.files
            .filter((f) => cloudInSubdir(workspacePath, f.relativePath ?? ""))
            .map((f) => cloudStripRel(workspacePath, f)),
        } as unknown as WorkspaceSearchResult;
      });
    }
    return invoke<WorkspaceSearchResult>("search_workspace_files_command", {
      input: { workspacePath, query },
    });
  },
  readFile(workspacePath: string, relativePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudRead<FileDocument>(
        conn,
        () =>
          invoke<FileDocument>("remote_workspace_read", {
            input: { connectionId: conn, relativePath: cloudToService(workspacePath, relativePath) },
          }).then((doc) => cloudStripRel(workspacePath, doc)),
        () => readOfflineFile(workspacePath, relativePath),
      );
    }
    return invoke<FileDocument>("read_workspace_file_command", {
      input: { workspacePath, relativePath },
    });
  },
  writeFile(workspacePath: string, relativePath: string, content: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudWriteMirrored<FileDocument>(
        conn,
        () =>
          invoke<FileDocument>("remote_workspace_write", {
            input: { connectionId: conn, relativePath: cloudToService(workspacePath, relativePath), content },
          }).then((doc) => cloudStripRel(workspacePath, doc)),
        () => writeOfflineFile(workspacePath, relativePath, content),
      );
    }
    return invoke<FileDocument>("write_workspace_file_command", {
      input: { workspacePath, relativePath, content },
    });
  },
  createFile(workspacePath: string, targetRelativePath: string | null, name: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudWriteMirrored<WorkspaceEntry>(
        conn,
        () =>
          invoke<WorkspaceEntry>("remote_workspace_create_file", {
            input: { connectionId: conn, targetRelativePath: cloudToService(workspacePath, targetRelativePath), name },
          }).then((e) => cloudStripRel(workspacePath, e)),
        () => createOfflineFile(workspacePath, targetRelativePath, name),
      );
    }
    return invoke<WorkspaceEntry>("create_workspace_file_command", {
      input: { workspacePath, targetRelativePath, name },
    });
  },
  createDirectory(
    workspacePath: string,
    targetRelativePath: string | null,
    name: string,
  ) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudWriteMirrored<WorkspaceEntry>(
        conn,
        () =>
          invoke<WorkspaceEntry>("remote_workspace_create_directory", {
            input: { connectionId: conn, targetRelativePath: cloudToService(workspacePath, targetRelativePath), name },
          }).then((e) => cloudStripRel(workspacePath, e)),
        () => createOfflineDirectory(workspacePath, targetRelativePath, name),
      );
    }
    return invoke<WorkspaceEntry>("create_workspace_directory_command", {
      input: { workspacePath, targetRelativePath, name },
    });
  },
  renameEntry(workspacePath: string, relativePath: string, newName: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudWriteMirrored<WorkspaceEntry>(
        conn,
        () =>
          invoke<WorkspaceEntry>("remote_workspace_rename", {
            input: { connectionId: conn, relativePath: cloudToService(workspacePath, relativePath), newName },
          }).then((e) => cloudStripRel(workspacePath, e)),
        () => renameOfflineEntry(workspacePath, relativePath, newName),
      );
    }
    return invoke<WorkspaceEntry>("rename_workspace_entry_command", {
      input: { workspacePath, relativePath, newName },
    });
  },
  deleteEntry(workspacePath: string, relativePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      return cloudWriteMirrored<void>(
        conn,
        () =>
          invoke<void>("remote_workspace_delete", {
            input: { connectionId: conn, relativePath: cloudToService(workspacePath, relativePath) },
          }),
        () => deleteOfflineEntry(workspacePath, relativePath),
      );
    }
    return invoke<void>("delete_workspace_entry_command", {
      input: { workspacePath, relativePath },
    });
  },
  async trashEntry(workspacePath: string, relativePath: string): Promise<WorkspaceDeletedEntry> {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      // axe:v2-l2.4b — corbeille du service : fs.trash, meme forme que le local.
      // `trashPath` porte l'identifiant de corbeille (seule prise pour restaurer).
      const trashed = await cloudWriteRpc<CloudTrashEntry>(conn, "fs.trash", {
        path: cloudToService(workspacePath, relativePath),
      });
      const path = trashed?.path ? cloudFromService(workspacePath, trashed.path) : relativePath;
      const segments = path.split("/").filter(Boolean);
      return {
        name: trashed?.name || segments[segments.length - 1] || path,
        relativePath: path,
        originalAbsolutePath: `${workspacePath.replace(/\/+$/, "")}/${path}`,
        trashPath: trashed?.id ?? "",
        kind: "file",
      };
    }
    return invoke<WorkspaceDeletedEntry>("trash_workspace_entry_command", {
      input: { workspacePath, relativePath },
    });
  },
  async restoreDeletedEntries(
    workspacePath: string,
    entries: WorkspaceDeletedEntry[],
  ): Promise<WorkspaceEntry[]> {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      // axe:v2-l2.4b — restauration cloud par identifiant (Ctrl+Z de l'explorateur).
      const restored: WorkspaceEntry[] = [];
      for (const entry of entries) {
        if (!entry.trashPath) continue;
        const res = await cloudWriteRpc<{ path?: string }>(conn, "fs.restore", {
          id: entry.trashPath,
        });
        restored.push(
          cloudFileEntry(workspacePath, res?.path ? cloudFromService(workspacePath, res.path) : entry.relativePath),
        );
      }
      return restored;
    }
    return invoke<WorkspaceEntry[]>("restore_workspace_deleted_entries_command", {
      input: { workspacePath, entries },
    });
  },
  revealEntry(workspacePath: string, relativePath: string) {
    return invoke<void>("reveal_workspace_entry_command", {
      input: { workspacePath, relativePath },
    });
  },
  revealAbsolutePath(path: string) {
    return invoke<void>("reveal_absolute_path_command", {
      input: { path },
    });
  },
  resolveTerminalPath(workspacePath: string, rawPath: string) {
    return invoke<TerminalPathResolution>("resolve_terminal_path_command", {
      input: { workspacePath, rawPath },
    });
  },
  readExternalFile(path: string) {
    return invoke<FileDocument>("read_external_file_command", {
      input: { path },
    });
  },
  async deleteSkill(workspacePath: string, path: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      assertCloudWritable(conn);
      const before = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      const name =
        before.find((skill) => skill.absolutePath === path)?.name ?? skillNameFromPath(path);
      await cloudWriteRpc<{ deleted: boolean }>(conn, "skills.delete", { name });
      const skills = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      return { name, skills };
    }
    return invoke<void>("delete_skill_command", {
      input: { workspacePath, path },
    });
  },
  async createSkill(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      assertCloudWritable(conn);
      const before = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      const name = nextSkillName(before);
      const created = await cloudWriteRpc<InstalledSkill>(conn, "skills.save", {
        name,
        description: "Décrivez à quoi sert ce skill",
        content: newSkillContent(name),
      });
      const skills = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      return { name: created.name || name, skills };
    }
    return invoke<{ name: string; skills: InstalledSkill[] }>(
      "create_skill_command",
      { input: { workspacePath } },
    );
  },
  async updateSkillContent(workspacePath: string, path: string, content: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      assertCloudWritable(conn);
      const before = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      const current = before.find((skill) => skill.absolutePath === path);
      const name =
        current?.name ?? skillFrontmatterValue(content, "name") ?? skillNameFromPath(path);
      const description =
        skillFrontmatterValue(content, "description") ?? current?.description ?? "";
      const updated = await cloudWriteRpc<InstalledSkill>(conn, "skills.save", {
        name,
        description,
        content,
      });
      const skills = await cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
      const resolved =
        skills.find((skill) => skill.absolutePath === path)?.name ?? updated?.name ?? name;
      return { name: resolved, skills };
    }
    return invoke<{ name: string; skills: InstalledSkill[] }>(
      "update_skill_content_command",
      { input: { workspacePath, path, content } },
    );
  },
  openExternalUrl(url: string) {
    return invoke<void>("open_external_url_command", {
      input: { url },
    });
  },
  openPathWithDefaultApp(path: string) {
    return invoke<void>("open_path_with_default_app_command", {
      input: { path },
    });
  },
  copyFileToPath(sourcePath: string, destinationPath: string) {
    return invoke<void>("copy_file_to_path_command", {
      input: { sourcePath, destinationPath },
    });
  },
  copyEntries(
    workspacePath: string,
    sources: string[],
    targetRelativePath: string | null,
    cut: boolean,
  ) {
    return invoke<WorkspaceEntry[]>("copy_workspace_entries_command", {
      input: { workspacePath, sources, targetRelativePath, cut },
    });
  },
  importPaths(
    workspacePath: string,
    sources: string[],
    targetRelativePath?: string,
  ) {
    return invoke<{ sourcePath: string; relativePath: string }[]>(
      "import_workspace_paths_command",
      { input: { workspacePath, sources, targetRelativePath } },
    );
  },
  readClipboardFilePaths() {
    return invoke<string[]>("read_clipboard_file_paths_command");
  },
  saveClipboardImage(
    workspacePath: string,
    name: string | null,
    mediaType: string,
    data: string,
  ) {
    return invoke<ClipboardImageAttachment>(
      "save_clipboard_image_attachment_command",
      {
        input: { workspacePath, name, mediaType, data },
      },
    );
  },
  async listConversations(workspacePath: string) {
    // axe:v2-l7 — en cloud, la liste vient du service (sessions.list), pas du poste.
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudListConversations(conn);
    return invoke<ConversationSummary[]>("list_conversations", {
      input: { workspacePath },
    });
  },
  createConversation(workspacePath: string) {
    return invoke<WorkspaceBootstrap>("create_conversation", {
      input: { workspacePath },
    });
  },
  async loadConversation(workspacePath: string, conversationId: string) {
    // axe:v2-l7 — en cloud, l'historique vient de `sessions.history`.
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudLoadConversation(conn, workspacePath, conversationId);
    return invoke<SavedConversation>("load_conversation", {
      input: { workspacePath, conversationId },
    });
  },
  async renameConversation(
    workspacePath: string,
    conversationId: string,
    title: string,
  ) {
    // axe:v2-l7 — `sessions.update` accepte un nouveau nom : on le route en cloud.
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      await cloudWriteRpc<{ ok?: boolean }>(conn, "sessions.update", {
        sessionId: conversationId,
        name: title,
      });
      return cloudListConversations(conn);
    }
    return invoke<ConversationSummary[]>("rename_conversation", {
      input: { workspacePath, conversationId, title },
    });
  },
  deleteConversation(workspacePath: string, conversationId: string) {
    // axe:e3 — la suppression d'une conversation active passe par ce chemin
    // local uniquement : sur un espace, le service refuse `sessions.delete`
    // tant que la conversation n'est pas archivée (voir
    // `deleteArchivedConversation`), et l'interface ne propose donc plus ce
    // bouton sur une conversation active.
    return invoke<WorkspaceBootstrap>("delete_conversation", {
      input: { workspacePath, conversationId },
    });
  },
  /// axe:e3 — archiver une conversation : elle quitte la liste active et part
  /// dans l'archive, dont le chemin n'est jamais montré. Renvoie la liste
  /// active rafraîchie.
  async archiveConversation(workspacePath: string, conversationId: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (!conn) {
      // axe:archive-locale — en local aussi, supprimer = archiver.
      return invoke<ConversationSummary[]>("archive_local", {
        input: { workspacePath, conversationId },
      });
    }
    await cloudWriteRpc<{ state?: string }>(conn, "sessions.archive", {
      sessionId: conversationId,
    });
    return cloudListConversations(conn);
  },
  /// axe:e3 — conversations rangées dans l'archive.
  async listArchivedConversations(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (!conn) {
      const list = await invoke<ConversationSummary[]>("list_archived_local", {
        input: { workspacePath },
      });
      return list.map((c) => ({ ...c, archived: true }));
    }
    return cloudListArchivedConversations(conn);
  },
  /// axe:e3 — rétablir une conversation archivée : elle revient dans la liste
  /// active. Renvoie la liste des archives à jour.
  async restoreArchivedConversation(
    workspacePath: string,
    conversationId: string,
  ) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (!conn) {
      const list = await invoke<ConversationSummary[]>("restore_local", {
        input: { workspacePath, conversationId },
      });
      return list.map((c) => ({ ...c, archived: true }));
    }
    await cloudWriteRpc<{ state?: string }>(conn, "sessions.restore", {
      sessionId: conversationId,
    });
    return cloudListArchivedConversations(conn);
  },
  /// axe:e3 — supprimer une conversation **archivée**. Le service refuse toute
  /// autre conversation : la suppression n'existe que depuis l'archive.
  async deleteArchivedConversation(workspacePath: string, conversationId: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (!conn) {
      const list = await invoke<ConversationSummary[]>("delete_archived_local", {
        input: { workspacePath, conversationId },
      });
      return list.map((c) => ({ ...c, archived: true }));
    }
    await cloudWriteRpc<{ state?: string }>(conn, "sessions.delete", {
      sessionId: conversationId,
    });
    return cloudListArchivedConversations(conn);
  },
  setConversationMode(
    workspacePath: string,
    conversationId: string,
    mode: AgentMode,
  ) {
    return invoke<SavedConversation>("set_conversation_mode", {
      input: { workspacePath, conversationId, mode },
    });
  },
  setConversationModelPreference(
    workspacePath: string,
    conversationId: string,
    mode: AgentMode,
    model: ModelRef,
    thinking: ThinkingLevel,
  ) {
    return invoke<ModeModelSettings>("set_conversation_model_preference", {
      input: { workspacePath, conversationId, mode, model, thinking },
    });
  },
  listMcpSettings() {
    return invoke<McpSettings>("list_mcp_settings");
  },
  saveMcpSettings(settings: McpSettings) {
    return invoke<McpSettings>("save_mcp_settings", {
      input: { settings },
    });
  },
  listToolSettings(workspacePath: string) {
    return invoke<ToolSettings>("list_tool_settings", {
      input: { workspacePath },
    });
  },
  saveToolSettings(workspacePath: string, settings: ToolSettings) {
    return invoke<ToolSettings>("save_tool_settings", {
      input: { workspacePath, settings },
    });
  },
  listConfiguredModelProviders() {
    return invoke<string[]>("list_configured_model_providers");
  },
  getOpenAiProviderStatus() {
    return invoke<OpenAiProviderStatus>("get_openai_provider_status");
  },
  startOpenAiOAuthLogin() {
    return invoke<StartOpenAiLoginOutput>("start_openai_oauth_login");
  },
  cancelOpenAiOAuthLogin() {
    return invoke<OpenAiProviderStatus>("cancel_openai_oauth_login");
  },
  disconnectOpenAiProvider() {
    return invoke<OpenAiProviderStatus>("disconnect_openai_provider");
  },
  getAnthropicProviderStatus() {
    return invoke<AnthropicProviderStatus>("get_anthropic_provider_status");
  },
  startAnthropicOAuthLogin() {
    return invoke<StartAnthropicLoginOutput>("start_anthropic_oauth_login");
  },
  cancelAnthropicOAuthLogin() {
    return invoke<AnthropicProviderStatus>("cancel_anthropic_oauth_login");
  },
  disconnectAnthropicProvider() {
    return invoke<AnthropicProviderStatus>("disconnect_anthropic_provider");
  },
  getGoogleProviderStatus() {
    return invoke<GoogleProviderStatus>("get_google_provider_status");
  },
  startGoogleOAuthLogin() {
    return invoke<StartGoogleLoginOutput>("start_google_oauth_login");
  },
  cancelGoogleOAuthLogin() {
    return invoke<GoogleProviderStatus>("cancel_google_oauth_login");
  },
  disconnectGoogleProvider() {
    return invoke<GoogleProviderStatus>("disconnect_google_provider");
  },
  getKimiProviderStatus() {
    return invoke<KimiProviderStatus>("get_kimi_provider_status");
  },
  startKimiOAuthLogin() {
    return invoke<StartKimiLoginOutput>("start_kimi_oauth_login");
  },
  cancelKimiOAuthLogin() {
    return invoke<KimiProviderStatus>("cancel_kimi_oauth_login");
  },
  disconnectKimiProvider() {
    return invoke<KimiProviderStatus>("disconnect_kimi_provider");
  },
  getOpenRouterProviderStatus() {
    return invoke<OpenRouterProviderStatus>("get_openrouter_provider_status");
  },
  validateOpenRouterApiKey(apiKey: string) {
    return invoke<OpenRouterProviderStatus>("validate_openrouter_api_key", {
      input: { apiKey },
    });
  },
  disconnectOpenRouterProvider() {
    return invoke<OpenRouterProviderStatus>("disconnect_openrouter_provider");
  },
  listOpenRouterModels() {
    return invoke<OpenRouterModel[]>("list_openrouter_models");
  },
  searchOpenRouterModels(query: string) {
    return invoke<OpenRouterModelSearchResult[]>("search_openrouter_models", {
      input: { query },
    });
  },
  addOpenRouterModel(model: OpenRouterModelSearchResult) {
    return invoke<OpenRouterModel[]>("add_openrouter_model", {
      input: { model },
    });
  },
  removeOpenRouterModel(id: string) {
    return invoke<OpenRouterModel[]>("remove_openrouter_model", {
      input: { id },
    });
  },
  probeMcpTools() {
    return invoke<McpServerProbe[]>("probe_mcp_tools");
  },
  getMcpOAuthStatus(serverId: string) {
    return invoke<McpOAuthStatus>("get_mcp_oauth_status", {
      input: { serverId },
    });
  },
  startMcpOAuthLogin(serverId: string) {
    return invoke<StartMcpOAuthLoginOutput>("start_mcp_oauth_login_command", {
      input: { serverId },
    });
  },
  cancelMcpOAuthLogin(serverId: string) {
    return invoke<McpOAuthStatus>("cancel_mcp_oauth_login", {
      input: { serverId },
    });
  },
  disconnectMcpOAuth(serverId: string) {
    return invoke<McpOAuthStatus>("disconnect_mcp_oauth", {
      input: { serverId },
    });
  },
  listInstalledSkills(workspacePath: string) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) return cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
    return invoke<InstalledSkill[]>("list_installed_skills_command", {
      input: { workspacePath },
    });
  },
  async saveSkillSettings(workspacePath: string, settings: SkillSettings) {
    const conn = cloudConnectionFromPath(workspacePath);
    if (conn) {
      await cloudWriteRpc<{ skills: { name: string; enabled: boolean }[] }>(
        conn,
        "skills.save_settings",
        { settings },
      );
      return cloudRpc<InstalledSkill[]>(conn, "skills.list", {});
    }
    return invoke<InstalledSkill[]>("save_skill_settings", {
      input: { workspacePath, settings },
    });
  },
  checkRewriteWorkspaceRestore(
    workspacePath: string,
    conversationId: string,
    historyIndex: number,
  ) {
    return invoke<RewriteWorkspaceRestoreCheck>("check_rewrite_workspace_restore", {
      input: { workspacePath, conversationId, historyIndex },
    });
  },
  sendMessage(
    workspacePath: string,
    conversationId: string,
    text: string,
    attachments: AttachmentInput[],
    model: ModelRef,
    thinking: ThinkingLevel,
    mode: AgentMode,
    serviceTier?: ServiceTier | null,
    rewriteFromHistoryIndex?: number,
    planControl?: PlanControl,
    messageVisibility?: MessageVisibility,
    revertWorkspaceChanges?: boolean,
  ) {
    return invoke<void>("send_message", {
      input: {
        workspacePath,
        conversationId,
        text,
        attachments,
        model,
        thinking,
        mode,
        serviceTier,
        rewriteFromHistoryIndex,
        planControl,
        messageVisibility,
        revertWorkspaceChanges,
      },
    });
  },
  compactConversation(
    workspacePath: string,
    conversationId: string,
    model: ModelRef,
    thinking: ThinkingLevel,
    serviceTier?: ServiceTier | null,
    instruction?: string,
  ) {
    return invoke<void>("compact_conversation", {
      input: { workspacePath, conversationId, model, thinking, serviceTier, instruction },
    });
  },
  listActiveTurns() {
    return invoke<ActiveTurnSummary[]>("list_active_turns");
  },
  replayActiveTurnEvents(
    workspacePath: string,
    conversationId: string,
    afterSequence?: number,
  ) {
    return invoke<ActiveTurnReplay>("replay_active_turn_events", {
      input: { workspacePath, conversationId, afterSequence },
    });
  },
  estimateContext(
    workspacePath: string,
    conversationId: string,
    text: string,
    attachments: AttachmentInput[],
    model: ModelRef,
    thinking: ThinkingLevel,
    mode: AgentMode,
    rewriteFromHistoryIndex?: number,
  ) {
    return invoke<ContextEstimate>("estimate_context", {
      input: {
        workspacePath,
        conversationId,
        text,
        attachments,
        model,
        thinking,
        mode,
        rewriteFromHistoryIndex,
      },
    });
  },
  estimateSubAgentContext(
    workspacePath: string,
    agentId: string,
    agentName: string | undefined,
    history: ChatMessage[],
    model: ModelRef,
    mode: AgentMode,
  ) {
    return invoke<ContextEstimate>("estimate_sub_agent_context", {
      input: {
        workspacePath,
        agentId,
        agentName,
        history,
        model,
        mode,
      },
    });
  },
  cancelTurn(workspacePath: string, conversationId: string) {
    return invoke<boolean>("cancel_turn", {
      input: { workspacePath, conversationId },
    });
  },
  answerQuestion(
    workspacePath: string,
    conversationId: string,
    toolCallId: string,
    answers: QuestionAnswer[],
    stopQuestions = false,
  ) {
    return invoke<boolean>("answer_question", {
      input: {
        workspacePath,
        conversationId,
        toolCallId,
        answers,
        stopQuestions,
      },
    });
  },
  rejectQuestion(
    workspacePath: string,
    conversationId: string,
    toolCallId: string,
  ) {
    return invoke<boolean>("reject_question", {
      input: { workspacePath, conversationId, toolCallId },
    });
  },
  runTerminalCommand(workspacePath: string, command: string) {
    return invoke<TerminalCommandResult>("run_terminal_command", {
      input: { workspacePath, command },
    });
  },
  spawnTerminal(
    workspacePath: string,
    sessionId: string,
    token: string,
    cols: number,
    rows: number,
    pixelWidth?: number,
    pixelHeight?: number,
    shell?: string,
  ) {
    return invoke<TerminalSpawnResult>("spawn_terminal", {
      input: {
        workspacePath,
        sessionId,
        token,
        cols,
        rows,
        pixelWidth,
        pixelHeight,
        shell,
      },
    });
  },
  writeTerminal(sessionId: string, token: string, data: string) {
    return invoke<void>("write_terminal", {
      input: { sessionId, token, data },
    });
  },
  resizeTerminal(
    sessionId: string,
    token: string,
    cols: number,
    rows: number,
    pixelWidth?: number,
    pixelHeight?: number,
  ) {
    return invoke<void>("resize_terminal", {
      input: { sessionId, token, cols, rows, pixelWidth, pixelHeight },
    });
  },
  killTerminal(sessionId: string, token: string) {
    return invoke<boolean>("kill_terminal", {
      input: { sessionId, token },
    });
  },
  // axe:v2-e12 — onglet « Prime Agent » epingle : la session de production, servie par le
  // portail. C'est l'application qui ouvre le WebSocket (l'en-tete d'autorisation ne peut pas
  // venir d'une page), puis les octets arrivent par les evenements `prime-term-data` /
  // `prime-term-exit`.
  primeTermOpen(connectionId: string) {
    return invoke<string>("prime_term_open", { input: { connectionId } });
  },
  primeTermWrite(id: string, data: string) {
    return invoke<void>("prime_term_write", { input: { id, data } });
  },
  primeTermResize(id: string, cols: number, rows: number) {
    return invoke<void>("prime_term_resize", { input: { id, cols, rows } });
  },
  primeTermClose(id: string) {
    return invoke<void>("prime_term_close", { input: { id } });
  },
  // ── Auto-updater ──────────────────────────────────────────────────────
  // Round-trips to the `tauri-plugin-updater` integration. Progress events
  // (`updater://progress`, `updater://finished`) are consumed by the
  // <UpdateBadge /> component via `@tauri-apps/api/event::listen`.
  checkForUpdate() {
    return invoke<UpdateInfo>("updater_check");
  },
  installUpdate() {
    return invoke<void>("updater_download_and_install");
  },
  restartForUpdate() {
    return invoke<void>("updater_restart");
  },
  currentAppVersion() {
    return invoke<string>("updater_current_version");
  },
  remoteGetStatus() {
    return invoke<RemoteStatus>("remote_get_status");
  },
  remoteSetEnabled(enabled: boolean, relayUrl?: string | null) {
    return invoke<RemoteStatus>("remote_set_enabled", {
      input: { enabled, relayUrl },
    });
  },
  remoteStartPairing() {
    return invoke<RemoteStatus>("remote_start_pairing");
  },
  remoteStopPairing() {
    return invoke<RemoteStatus>("remote_stop_pairing");
  },
  remoteRevokeDevice(deviceId: string) {
    return invoke<RemoteStatus>("remote_revoke_device", {
      input: { deviceId },
    });
  },
};

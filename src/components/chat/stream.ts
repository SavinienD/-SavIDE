import type {
  AgentEvent,
  ChatMessage,
  FileChange,
  ModelRef,
  Part,
  PlanArtifact,
  ToolCallPart,
  ToolResultImage,
  ToolResultPart,
} from "../../types";
import { canonicalToolName, isToolName } from "../../lib/tools";
import { resumeOutilEnFrancais } from "./resumesOutils";

const MIN_VISIBLE_TURN_DURATION_MS = 90_000;
const CLEANED_TOOL_OUTPUT =
  "[Tool result cleaned by you: irrelevant to future context.]";
const COMPACTION_SUMMARY_PREFIX =
  "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
const LIVE_WRITE_DIFF_LINE_LIMIT = 400;

// -----------------------------------------------------------------
// View model used to render the chat pane. It flattens the history
// into an ordered list of "blocks" that are easy to render.
// -----------------------------------------------------------------

export type UserAttachment = { path: string; name: string };

export type ChatBlock =
  | {
      kind: "user-text";
      id: string;
      text: string;
      historyIndex: number;
      attachments?: UserAttachment[];
    }
  | {
      kind: "compaction-summary";
      id: string;
      text: string;
      historyIndex: number;
      streaming?: boolean;
    }
  | {
      kind: "compaction-marker";
      id: string;
      compactedAtMs?: number;
      targetConversationId?: string;
    }
  | { kind: "assistant-text"; id: string; text: string }
  | { kind: "plan"; id: string; artifact: PlanArtifact }
  | {
      kind: "plan-writing";
      id: string;
      label: string;
      text: string;
    }
  | {
      kind: "thinking";
      id: string;
      text: string;
      streaming?: boolean;
      startedAtMs?: number;
      durationMs?: number;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      summary?: string;
      argsPretty?: string;
      argsRaw?: string;
      output?: string;
      isError?: boolean;
      cleaned?: boolean;
      hidden?: boolean;
      answered?: boolean;
      answer?: string;
      fileChanges?: FileChange[];
      liveFileChange?: FileChange;
      images?: ToolResultImage[];
      meta?: Record<string, unknown> | null;
      subAgent?: SubAgentBlock;
    }
  | {
      kind: "agent-status";
      id: string;
      agentName: string;
      status: "slept";
      teamName?: string;
    }
  | {
      kind: "turn-duration";
      id: string;
      durationMs: number;
    };

export type SubAgentBlock = {
  id: string;
  agentId?: string;
  name: string;
  model?: ModelRef;
  history?: ChatMessage[];
  queuedMessages?: {
    id?: string;
    from?: string;
    to?: string;
    message: string;
  }[];
};

// Stream status = idle → streaming → idle (or stopped on interrupt/error).
export type StreamStatus = "idle" | "streaming" | "stopped";
export type StreamPhase =
  | "idle"
  | "waiting"
  | "thinking"
  | "responding"
  | "tooling";

export type ChatViewState = {
  blocks: ChatBlock[];
  status: StreamStatus;
  streamPhase: StreamPhase;
  lastError: string | null;
  turnStartedAtMs: number | null;
  /** axe:reprise-tour — index du premier bloc du tour en cours : « stream_retry »
   *  ne retire jamais un bloc d'un tour précédent (tour de continuation enchaîné). */
  liveFrom?: number;
};

export function initialStateFromHistory(history: ChatMessage[]): ChatViewState {
  return {
    blocks: blocksFromHistory(history),
    status: "idle",
    streamPhase: "idle",
    lastError: null,
    turnStartedAtMs: null,
  };
}

function isHiddenUserText(part: Part): boolean {
  if (part.type !== "text") return false;
  const meta = part.meta;
  if (!meta || typeof meta !== "object") return false;
  const record = meta as Record<string, unknown>;
  return (
    record.attachment_context === true ||
    record.plan_control === "stop_questions" ||
    record.system_reminder === true ||
    record.compaction_retained_user === true ||
    record.ui_only === true
  );
}

function isCompactionSummaryText(part: Part): boolean {
  return (
    part.type === "text" &&
    !!part.meta &&
    typeof part.meta === "object" &&
    (part.meta as Record<string, unknown>).compaction_summary === true
  );
}

function isCompactionMarkerText(part: Part): boolean {
  return (
    part.type === "text" &&
    !!part.meta &&
    typeof part.meta === "object" &&
    (part.meta as Record<string, unknown>).compaction_marker === true
  );
}

function compactionMarkerFromMeta(meta: unknown): {
  compactedAtMs?: number;
  targetConversationId?: string;
} {
  if (!meta || typeof meta !== "object") return {};
  const record = meta as Record<string, unknown>;
  return {
    compactedAtMs:
      typeof record.compacted_at_ms === "number"
        ? record.compacted_at_ms
        : undefined,
    targetConversationId:
      typeof record.target_conversation_id === "string"
        ? record.target_conversation_id
        : undefined,
  };
}

function compactionSummaryForDisplay(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(COMPACTION_SUMMARY_PREFIX)) return trimmed;
  return trimmed.slice(COMPACTION_SUMMARY_PREFIX.length).trim();
}

function compactionSummaryFromToolMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const record = meta as Record<string, unknown>;
  const value = record.compactionSummary ?? record.compaction_summary;
  if (typeof value !== "string") return null;
  const summary = compactionSummaryForDisplay(value);
  return summary.length > 0 ? summary : null;
}

function liveCompactionBlockId(toolCallId: string): string {
  return `s-compact-${toolCallId}`;
}

function liveCompactionBlockIndex(blocks: ChatBlock[], toolCallId: string): number {
  const blockId = liveCompactionBlockId(toolCallId);
  return blocks.findIndex(
    (block) => block.kind === "compaction-summary" && block.id === blockId,
  );
}

function isPlanSource(part: Part): boolean {
  if (part.type !== "text") return false;
  const meta = part.meta;
  return (
    typeof meta === "object" &&
    meta !== null &&
    (meta as Record<string, unknown>).plan_source === true
  );
}

function planArtifactFromMeta(meta: unknown): PlanArtifact | null {
  if (!meta || typeof meta !== "object") return null;
  const artifact = (meta as Record<string, unknown>).plan_artifact;
  if (!artifact || typeof artifact !== "object") return null;
  const record = artifact as Record<string, unknown>;
  if (typeof record.path !== "string" || !record.path.trim()) return null;
  return {
    path: record.path,
    absolutePath:
      typeof record.absolutePath === "string" ? record.absolutePath : undefined,
    title: typeof record.title === "string" ? record.title : undefined,
    updatedAtMs:
      typeof record.updatedAtMs === "number" ? record.updatedAtMs : undefined,
  };
}

function attachmentFromValue(value: unknown): UserAttachment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.path !== "string") return null;
  return {
    path: record.path,
    name: typeof record.name === "string" ? record.name : basename(record.path),
  };
}

function attachmentsFromMeta(meta: unknown): UserAttachment[] {
  if (!meta || typeof meta !== "object") return [];
  const record = meta as Record<string, unknown>;
  const single = attachmentFromValue(record.attachment);
  if (single) return [single];
  if (!Array.isArray(record.attachments)) return [];
  return record.attachments
    .map(attachmentFromValue)
    .filter((item): item is UserAttachment => item !== null);
}

function attachmentsFromUserMessage(message: ChatMessage): UserAttachment[] {
  const byPath = new Map<string, UserAttachment>();
  for (const part of message.parts) {
    for (const attachment of attachmentsFromMeta(part.meta)) {
      byPath.set(attachment.path, attachment);
    }
  }
  return Array.from(byPath.values());
}

function blocksFromHistory(history: ChatMessage[]): ChatBlock[] {
  const blocks: ChatBlock[] = [];
  let counter = 0;
  const id = (tag: string) => `h-${tag}-${counter++}`;
  // map tool_call id -> tool_result (may come as a user-role follow-up)
  const toolResults = new Map<string, ToolResultPart>();
  for (const message of history) {
    if (message.role === "user") {
      for (const part of message.parts) {
        if (part.type === "tool_result") {
          toolResults.set(part.tool_call_id, part);
        }
      }
    }
  }

  for (const [historyIndex, message] of history.entries()) {
    if (message.role === "user") {
      const attachments = attachmentsFromUserMessage(message);
      let attachedToFirstText = false;
      // Render only plain text parts, skipping attachment-context shims
      // and tool_result parts (which attach to the assistant's tool_call).
      for (const part of message.parts) {
        if (part.type !== "text") continue;
        if (isCompactionMarkerText(part)) {
          blocks.push({
            kind: "compaction-marker",
            id: id("compact-marker"),
            ...compactionMarkerFromMeta(part.meta),
          });
          continue;
        }
        if (isCompactionSummaryText(part)) {
          blocks.push({
            kind: "compaction-summary",
            id: id("compact"),
            text: compactionSummaryForDisplay(part.text),
            historyIndex,
          });
          continue;
        }
        if (isHiddenUserText(part)) continue;
        const trimmed = part.text.trim();
        if (!trimmed) continue;
        blocks.push({
          kind: "user-text",
          id: id("u"),
          text: part.text,
          historyIndex,
          attachments:
            !attachedToFirstText && attachments.length > 0
              ? attachments
              : undefined,
        });
        attachedToFirstText = true;
      }
    } else {
      for (const part of message.parts) {
        const planArtifact = planArtifactFromMeta(part.meta);
        if (planArtifact) {
          blocks.push({
            kind: "plan",
            id: id("p"),
            artifact: planArtifact,
          });
        } else if (part.type === "text") {
          if (isPlanSource(part)) continue;
          if (!part.text) continue;
          blocks.push({ kind: "assistant-text", id: id("a"), text: part.text });
        } else if (part.type === "thinking") {
          if (!hasVisibleThinkingText(part.text)) continue;
          const rawDuration = (part.meta as { duration_ms?: unknown } | null | undefined)
            ?.duration_ms;
          const durationMs =
            typeof rawDuration === "number" && Number.isFinite(rawDuration)
              ? rawDuration
              : undefined;
          blocks.push({ kind: "thinking", id: id("t"), text: part.text, durationMs });
        } else if (part.type === "tool_call") {
          const tc = part as ToolCallPart;
          const result = toolResults.get(tc.id);
          const silentBashPoll = silentBashPollInfo(tc.name, tc.input);
          if (silentBashPoll && result) {
            const targetIndex = findBashSessionBlockIndex(
              blocks,
              silentBashPoll.sessionId,
            );
            if (targetIndex >= 0) {
              const target = blocks[targetIndex];
              if (target.kind === "tool") {
                blocks[targetIndex] = mergeBashPollResult(
                  target,
                  result,
                  silentBashPoll.sessionId,
                );
                continue;
              }
            }
            if (
              !result.is_error &&
              isOnlyBashRunningNotice(result.content, silentBashPoll.sessionId)
            ) {
              continue;
            }
          }
          if (result) {
            const visibleBashInput = visibleBashInputInfo(tc.name, tc.input);
            if (visibleBashInput) {
              const targetIndex = findBashSessionBlockIndex(
                blocks,
                visibleBashInput.sessionId,
              );
              if (targetIndex >= 0) {
                const target = blocks[targetIndex];
                if (target.kind === "tool") {
                  blocks[targetIndex] = mergeBashPollResult(
                    target,
                    result,
                    visibleBashInput.sessionId,
                  );
                }
              }
            }
          }
          const fileChanges = (result?.meta as { file_changes?: FileChange[] } | null)
            ?.file_changes;
          blocks.push({
            kind: "tool",
            id: tc.id,
            name: tc.name,
            status: result ? (result.is_error ? "error" : "done") : "error",
            summary: summaryFromInput(tc.name, tc.input, tc.meta),
            argsPretty: prettyToolInput(tc.name, tc.input),
            output: result?.content ?? "Appel d'outil interrompu avant l'enregistrement du résultat.",
            isError: result?.is_error ?? true,
            cleaned: isToolResultCleaned(result),
            answered: isToolName(tc.name, "question") ? !!result && !result.is_error : undefined,
            answer: isToolName(tc.name, "question") ? questionAnswerFromResult(result) : undefined,
            fileChanges,
            images: result?.images,
            meta: result?.meta,
            subAgent: subAgentFromToolResult(tc.id, tc.name, result),
          });
        }
      }
    }
  }
  return blocks;
}

function isToolResultCleaned(result?: ToolResultPart): boolean {
  const meta = result?.meta;
  return (
    !!meta &&
    typeof meta === "object" &&
    (meta as Record<string, unknown>).tool_result_cleaned === true
  );
}

function questionAnswerFromResult(result?: ToolResultPart): string | undefined {
  return questionAnswerFromMeta(result?.meta);
}

function questionAnswerFromMeta(meta?: Record<string, unknown> | null): string | undefined {
  const raw = meta?.question_answers;
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((item) =>
      Array.isArray(item)
        ? item.map((value) => String(value).trim()).filter(Boolean).join(", ")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

type BashInputInfo = {
  sessionId: number;
  input: string;
  kill: boolean;
};

function bashInputInfo(input: unknown): BashInputInfo | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const sessionId = record.session_id;
  if (typeof sessionId !== "number" || !Number.isFinite(sessionId)) return null;
  return {
    sessionId,
    input: typeof record.input === "string" ? record.input : "",
    kill: record.kill === true,
  };
}

function silentBashPollInfo(name: string, input: unknown): BashInputInfo | null {
  if (name !== "bash_input") return null;
  const info = bashInputInfo(input);
  if (!info || info.kill || info.input.trim()) return null;
  return info;
}

function visibleBashInputInfo(name: string, input: unknown): BashInputInfo | null {
  if (name !== "bash_input") return null;
  const info = bashInputInfo(input);
  if (!info || (!info.kill && !info.input.trim())) return null;
  return info;
}

function bashInputShouldStayHidden(input: unknown, fallback: boolean): boolean {
  const info = bashInputInfo(input);
  if (!info) return fallback;
  return !info.kill && !info.input.trim();
}

function bashRunningNotice(sessionId: number): RegExp {
  return new RegExp(
    `\\n?\\[process still running: (?:bash|PowerShell) session ${sessionId}\\]\\nUse bash_input with session_id ${sessionId} to send input or poll output\\. Include a newline when answering a prompt\\. Use kill=true to stop it\\.\\s*$`,
    "s",
  );
}

function stripBashRunningNotice(output: string, sessionId: number): string {
  return output.replace(bashRunningNotice(sessionId), "");
}

function isOnlyBashRunningNotice(output: string, sessionId: number): boolean {
  return (
    bashRunningNotice(sessionId).test(output) &&
    stripBashRunningNotice(output, sessionId).trim().length === 0
  );
}

function bashSessionIdFromOutput(output?: string): number | null {
  if (!output) return null;
  const match = output.match(/\[process still running: (?:bash|PowerShell) session (\d+)\]/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function bashSessionIdFromToolBlock(
  block: Extract<ChatBlock, { kind: "tool" }>,
): number | null {
  const fromArgs = bashInputInfo(parsePrettyJson(block.argsPretty ?? ""))?.sessionId;
  if (typeof fromArgs === "number") return fromArgs;
  return bashSessionIdFromOutput(block.output);
}

function findBashSessionBlockIndex(
  blocks: ChatBlock[],
  sessionId: number,
  ignoreId?: string,
): number {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== "tool" || block.hidden || block.id === ignoreId) continue;
    if (block.name !== "bash" && block.name !== "bash_input") continue;
    if (block.status !== "running") continue;
    if (bashSessionIdFromToolBlock(block) === sessionId) return index;
  }
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind !== "tool" || block.hidden || block.id === ignoreId) continue;
    if (block.name !== "bash" && block.name !== "bash_input") continue;
    if (bashSessionIdFromToolBlock(block) === sessionId) return index;
  }
  return -1;
}

function mergeBashPollResult(
  block: Extract<ChatBlock, { kind: "tool" }>,
  result: ToolResultPart,
  sessionId: number,
): Extract<ChatBlock, { kind: "tool" }> {
  const output = mergeBashSessionOutput(block.output, result.content, sessionId);
  const meta = result.meta ?? block.meta;
  const resultFileChanges = (
    result.meta as { file_changes?: FileChange[] } | null | undefined
  )?.file_changes;
  const stillRunning = bashSessionIdFromOutput(output) === sessionId;
  return {
    ...block,
    status: result.is_error ? "error" : stillRunning ? "running" : "done",
    output,
    isError: result.is_error ? true : block.isError,
    fileChanges: resultFileChanges?.length ? resultFileChanges : block.fileChanges,
    images: result.images && result.images.length > 0 ? result.images : block.images,
    meta,
  };
}

function mergeBashSessionOutput(
  previous: string | undefined,
  incoming: string,
  sessionId: number,
): string {
  if (isOnlyBashRunningNotice(incoming, sessionId)) return previous ?? incoming;
  const base = stripBashRunningNotice(previous ?? "", sessionId).trimEnd();
  if (!base) return incoming;
  if (!incoming) return base;
  const separator = base.endsWith("\n") || incoming.startsWith("\n") ? "" : "\n";
  return `${base}${separator}${incoming}`;
}

function subAgentFromToolResult(
  id: string,
  toolName: string,
  result?: ToolResultPart,
): SubAgentBlock | undefined {
  const meta = result?.meta;
  const raw =
    meta && typeof meta === "object"
      ? (meta as Record<string, unknown>).subagent
      : null;
  if (!isSubAgentLikeTool(toolName) && !raw) return undefined;
  if (!raw || typeof raw !== "object") {
    return { id, name: isToolName(toolName, "agent") ? "Agent" : "Sous-agent" };
  }
  const record = raw as Record<string, unknown>;
  return {
    id,
    agentId: typeof record.id === "string" ? record.id : undefined,
    name: typeof record.name === "string" ? record.name : "Sous-agent",
    model:
      record.model && typeof record.model === "object"
        ? (record.model as ModelRef)
        : undefined,
    history: Array.isArray(record.history)
      ? (record.history as ChatMessage[])
      : undefined,
  };
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function summaryFromInput(
  name: string,
  input: unknown,
  meta?: Record<string, unknown> | null,
): string | undefined {
  const canonicalName = canonicalToolName(name);
  if (name.startsWith("mcp__")) {
    return mcpSummaryFromMeta(meta) ?? mcpSummaryFromName(name);
  }
  if (canonicalName === "bash" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.command === "string") return record.command;
  }
  if (canonicalName === "bash_input" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const session = typeof record.session_id === "number" ? record.session_id : null;
    if (record.kill === true && session !== null) return `Arrêter la session shell ${session}`;
    if (typeof record.input === "string" && record.input.trim() && session !== null) {
      return `Saisie dans la session shell ${session}`;
    }
    if (session !== null) return `Lire la session shell ${session}`;
  }
  if (canonicalName === "read" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string") return `Lire ${record.path}`;
  }
  if (canonicalName === "edit_file") {
    return editFileSummary(input);
  }
  if (canonicalName === "write_file" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.path === "string" && record.path.trim()) {
      return `Écrire ${record.path.trim()}`;
    }
    return "Écrire un fichier";
  }
  if (canonicalName === "clean_context") {
    return "Nettoyer le contexte";
  }
  if (canonicalName === "context_compaction") {
    return "Contexte compacté";
  }
  if (canonicalName === "create_image" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.prompt === "string" && record.prompt.trim()) {
      const prompt = record.prompt.trim();
      return `Créer une image : ${prompt.length > 64 ? `${prompt.slice(0, 61)}…` : prompt}`;
    }
    return "Créer une image";
  }
  if (canonicalName === "todo_list") {
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      if (
        typeof record.changes === "string" &&
        /^(close|clear|reset)\s*$/i.test(record.changes.trim())
      ) {
        return "Fermer la liste de tâches";
      }
    }
    return "Mettre à jour la liste de tâches";
  }
  if (canonicalName === "question" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (Array.isArray(record.questions)) {
      const count = record.questions.length;
      return count === 1 ? "Question" : `${count} questions`;
    }
    if (typeof record.question === "string" && record.question.trim()) {
      return record.question.trim();
    }
    return "Question";
  }
  if (canonicalName === "skill" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.trim()) {
      return `Skill : ${record.name.trim()}`;
    }
    return "Skill";
  }
  if (name.startsWith("subagent_") && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.task === "string" && record.task.trim()) {
      return `Sous-agent : ${record.task.trim()}`;
    }
    return "Sous-agent";
  }
  if (canonicalName === "team_run" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const agent = typeof record.agent === "string" ? record.agent.trim() : "";
    const objective = typeof record.objective === "string" ? record.objective.trim() : "";
    if (agent) return `Relancer @${agent.replace(/^@/, "")}`;
    if (objective) return `Essaim d'agents : ${objective}`;
    return "Essaim d'agents";
  }
  if (canonicalName === "team_create" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.team_name === "string" && record.team_name.trim()) {
      return `Équipe : ${record.team_name.trim()}`;
    }
    return "Créer une équipe";
  }
  if (canonicalName === "agent" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const teammate = typeof record.name === "string" ? record.name.trim() : "";
    const task =
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : typeof record.prompt === "string"
          ? record.prompt.trim()
          : "";
    if (teammate && task) return `Agent : @${teammate} · ${task}`;
    if (teammate) return `Agent : @${teammate}`;
    return "Équipier";
  }
  if (canonicalName === "send_message" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.to === "string" && record.to.trim()) {
      return `Message : ${record.to.trim()}`;
    }
    return "Message à l'équipe";
  }
  if (canonicalName === "task_create" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.subject === "string" && record.subject.trim()) {
      return `Tâche : ${record.subject.trim()}`;
    }
    return "Créer une tâche";
  }
  if (canonicalName === "task_list") return "Liste des tâches";
  if (canonicalName === "task_update" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const taskId =
      typeof record.taskId === "string" || typeof record.taskId === "number"
        ? String(record.taskId).trim()
        : typeof record.id === "string" || typeof record.id === "number"
          ? String(record.id).trim()
          : "";
    const status = typeof record.status === "string" ? record.status.trim() : "";
    if (taskId && status) return `Tâche : #${taskId} · ${status}`;
    if (taskId) return `Tâche : #${taskId}`;
    return "Mettre à jour la tâche";
  }
  if (canonicalName === "team_status") return "État de l'équipe";
  if (canonicalName === "team_stop") return "Arrêter l'équipe";
  if (canonicalName === "load_mcp_tool" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const server =
      typeof record.server === "string" ? mcpServerLabel(record.server) : "";
    const tool =
      typeof record.tool === "string"
        ? record.tool
        : typeof record.name === "string"
          ? record.name
          : "";
    if (server && tool) return `Charger ${server} · ${tool}`;
    return "Charger un outil MCP";
  }
  if (canonicalName === "web_search" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const q = typeof record.q === "string" ? record.q : record.query;
    if (typeof q === "string" && q.trim()) return `Recherche web : ${q.trim()}`;
    return "Recherche web";
  }
  if (canonicalName === "web_fetch" && input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.url === "string" && record.url.trim()) return `Lire ${record.url.trim()}`;
    return "Lire une URL";
  }
  try {
    const s = JSON.stringify(input);
    if (s.length <= 72) return s;
    return s.slice(0, 69) + "…";
  } catch {
    return undefined;
  }
}

function mcpSummaryFromMeta(
  meta?: Record<string, unknown> | null,
): string | undefined {
  const mcp = meta?.mcp;
  if (!mcp || typeof mcp !== "object") return undefined;
  const record = mcp as Record<string, unknown>;
  const serverName =
    typeof record.serverName === "string" ? record.serverName.trim() : "";
  const toolName =
    typeof record.toolName === "string" ? record.toolName.trim() : "";
  if (serverName && toolName) return `${mcpServerLabel(serverName)} · ${toolName}`;
  if (serverName) return mcpServerLabel(serverName);
  return undefined;
}

function mcpSummaryFromName(name: string): string | undefined {
  const [, rawServer, ...rawToolParts] = name.split("__");
  const server = mcpServerLabel(rawServer || "MCP", true);
  const tool = genericMcpLabel(rawToolParts.join("__") || "outil");
  return `${server} · ${tool}`;
}

function mcpServerLabel(value: string, generated = false): string {
  const trimmed = value.trim();
  const stripped = trimmed
    .replace(/^mcp(?=[A-Z0-9])/i, "")
    .replace(/^mcp[-_.\s]+/i, "")
    .trim();
  const label = stripped || trimmed || "MCP";
  return generated ? genericMcpLabel(label) : label;
}

function genericMcpLabel(value: string): string {
  const words = value
    .replace(/_[0-9a-f]{8}$/i, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_.]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return words.join(" ") || "Outil";
}

function pendingSummary(name: string): string | undefined {
  const canonicalName = canonicalToolName(name);
  if (canonicalName === "bash") return "Commande en cours";
  if (canonicalName === "bash_input") return "Échange avec la commande";
  if (canonicalName === "edit_file") return "Préparation de la modification";
  if (canonicalName === "write_file") return "Préparation de l'écriture";
  if (canonicalName === "clean_context") return "Nettoyage du contexte";
  if (canonicalName === "context_compaction") return "Compactage du contexte";
  if (canonicalName === "update_goal") return "Finalisation de l'objectif";
  if (canonicalName === "todo_list") return "Mise à jour de la liste de tâches";
  if (canonicalName === "question") return "Préparation de la question";
  if (canonicalName === "load_mcp_tool") return "Chargement de l'outil MCP";
  if (canonicalName === "skill") return "Chargement du skill";
  if (canonicalName === "web_search") return "Préparation de la recherche web";
  if (canonicalName === "web_fetch") return "Préparation de la lecture web";
  if (canonicalName === "create_image") return "Création de l'image";
  if (name.startsWith("subagent_")) return "Démarrage du sous-agent";
  if (canonicalName === "team_run") return "Démarrage de l'essaim d'agents";
  if (canonicalName === "team_create") return "Création de l'équipe";
  if (canonicalName === "agent") return "Démarrage de l'équipier";
  if (canonicalName === "send_message") return "Envoi du message à l'équipe";
  if (canonicalName === "task_create") return "Création de la tâche";
  if (canonicalName === "task_list") return "Vérification des tâches";
  if (canonicalName === "task_update") return "Mise à jour de la tâche";
  if (canonicalName === "team_status") return "Vérification de l'équipe";
  if (canonicalName === "team_stop") return "Arrêt de l'équipe";
  return undefined;
}

function isSubAgentLikeTool(name: string): boolean {
  return name.startsWith("subagent_") || isToolName(name, "agent");
}

function subAgentNameFromSummary(summary: string): string | null {
  const parts = summary.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^(sub|sous)-agent$/i.test(parts[0])) {
    return parts.slice(1).join(" · ");
  }
  if (parts.length >= 2 && /^agent$/i.test(parts[0])) {
    return parts[1]?.replace(/^@/, "") ?? null;
  }
  return null;
}

function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function prettyToolInput(name: string, input: unknown): string {
  return prettyJson(displayToolInput(name, input));
}

function displayToolInput(name: string, input: unknown): unknown {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return input;
  }
  const record = input as Record<string, unknown>;
  const cleaned = omitInternalTeamFields(record);
  if (!isToolName(name, "team_run")) return cleaned;
  const agent = typeof record.agent === "string" ? record.agent.trim() : "";
  if (!agent) return compactTeamRunInput(cleaned);
  return { agent };
}

function compactTeamRunInput(input: Record<string, unknown>): Record<string, unknown> {
  const cleaned = omitInternalTeamFields(input);
  return Object.fromEntries(
    Object.entries(cleaned).filter(
      ([key]) => key !== "agent_count" && key !== "subagent_type",
    ),
  );
}

function omitInternalTeamFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => key !== "team_name"),
  );
}

function hasVisibleThinkingText(text: string): boolean {
  return text.trim().length > 0;
}

function cleanContextIdsFromArgs(argsPretty?: string): Set<string> {
  const input = argsPretty ? parsePrettyJson(argsPretty) : null;
  if (!input || typeof input !== "object") return new Set();
  const values = (input as Record<string, unknown>).tool_call_ids;
  if (!Array.isArray(values)) return new Set();
  return new Set(values.filter((value): value is string => typeof value === "string"));
}

function readJsonStringToken(
  input: string,
  start: number,
): { value: string; end: number; complete: boolean } | null {
  if (input[start] !== '"') return null;
  let value = "";
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      return { value, end: index + 1, complete: true };
    }
    if (char !== "\\") {
      value += char;
      continue;
    }

    index += 1;
    if (index >= input.length) {
      return { value, end: input.length, complete: false };
    }
    const escaped = input[index];
    switch (escaped) {
      case '"':
      case "\\":
      case "/":
        value += escaped;
        break;
      case "b":
        value += "\b";
        break;
      case "f":
        value += "\f";
        break;
      case "n":
        value += "\n";
        break;
      case "r":
        value += "\r";
        break;
      case "t":
        value += "\t";
        break;
      case "u": {
        const hex = input.slice(index + 1, index + 5);
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { value, end: input.length, complete: false };
        }
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
        break;
      }
      default:
        value += escaped;
        break;
    }
  }
  return { value, end: input.length, complete: false };
}

function skipJsonWhitespace(input: string, index: number): number {
  while (index < input.length && /\s/.test(input[index])) index += 1;
  return index;
}

function jsonStringProperty(
  input: string,
  property: string,
): { value: string; complete: boolean } | null {
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '"') continue;
    const key = readJsonStringToken(input, index);
    if (!key) continue;
    if (!key.complete) return null;
    index = key.end;
    let valueStart = skipJsonWhitespace(input, index);
    if (input[valueStart] !== ":") continue;
    valueStart = skipJsonWhitespace(input, valueStart + 1);
    if (key.value !== property) continue;
    const value = readJsonStringToken(input, valueStart);
    return value ? { value: value.value, complete: value.complete } : null;
  }
  return null;
}

function readPathFromPartialJson(input: string): string | null {
  const path = jsonStringProperty(input, "path")?.value?.trim();
  return path || null;
}

function liveWriteDiffLines(content: string): FileChange["lines"] {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return lines.slice(0, LIVE_WRITE_DIFF_LINE_LIMIT).map((text) => ({
    kind: "added" as const,
    text,
  }));
}

function liveWriteFileChangeFromInput(input: unknown): FileChange | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const record = input as Record<string, unknown>;
  const path = typeof record.path === "string" ? record.path.trim() : "";
  if (!path) return undefined;
  if (typeof record.content !== "string" || record.content.length === 0) return undefined;
  const allLines = record.content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return {
    relativePath: path,
    kind: "added",
    summary: `Écriture de ${path}`,
    binary: false,
    addedLines: allLines.length,
    removedLines: 0,
    truncated: allLines.length > LIVE_WRITE_DIFF_LINE_LIMIT,
    lines: liveWriteDiffLines(record.content),
  };
}

function partialWriteFileArgs(input: string): Record<string, unknown> | null {
  const path = jsonStringProperty(input, "path");
  const content = jsonStringProperty(input, "content");
  if (!path && !content) return null;
  const output: Record<string, unknown> = {};
  if (path) output.path = path.value;
  if (content) output.content = content.value;
  return Object.keys(output).length > 0 ? output : null;
}

function partialArgsFromToolJson(
  name: string,
  input: string,
): Record<string, unknown> | null {
  if (name === "read") {
    const path = readPathFromPartialJson(input);
    return path ? { path } : null;
  }
  if (name === "edit_file") {
    return partialEditFileArgs(input);
  }
  if (name === "write_file") {
    return partialWriteFileArgs(input);
  }
  return null;
}

function editFileGroups(input: Record<string, unknown>): unknown[] | null {
  const files = input.files;
  return Array.isArray(files) ? files : null;
}

function replacementCount(groups: unknown[]): number {
  return groups.reduce<number>((total, group) => {
    if (!group || typeof group !== "object") return total;
    const edits = (group as Record<string, unknown>).edits;
    return total + (Array.isArray(edits) ? edits.length : 0);
  }, 0);
}

function editFileSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "Modifier un fichier";
  const groups = editFileGroups(input as Record<string, unknown>);
  if (!groups || groups.length === 0) return "Modifier un fichier";
  const replacements = replacementCount(groups);
  if (groups.length === 1) {
    const first = groups[0];
    if (first && typeof first === "object") {
      const path = (first as Record<string, unknown>).path;
      if (typeof path === "string" && path.trim()) {
        return replacements > 1
          ? `Modifier ${path.trim()} · ${replacements} remplacements`
          : `Modifier ${path.trim()}`;
      }
    }
    return replacements > 1 ? `Modifier un fichier · ${replacements} remplacements` : "Modifier un fichier";
  }
  return replacements > 0
    ? `Modifier des fichiers · ${groups.length} fichiers · ${replacements} remplacements`
    : `Modifier des fichiers · ${groups.length} fichiers`;
}

function partialEditFileArgs(input: string): Record<string, unknown> | null {
  const paths = [...input.matchAll(/"path"\s*:\s*"((?:\\.|[^"\\])*)/g)]
    .map((match) => {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return match[1].replace(/\\"/g, '"');
      }
    })
    .filter((path) => path.trim());
  if (paths.length === 0) return null;
  return { files: paths.map((path) => ({ path })) };
}

// -----------------------------------------------------------------
// Event reducer: apply an AgentEvent to the ChatViewState.
// We use a simple rolling pointer for the "currently streaming" text,
// thinking, or tool block. When an event arrives we create/extend it.
// -----------------------------------------------------------------

function finalizeStreamingThinking(blocks: ChatBlock[]): ChatBlock[] {
  const next = blocks.slice();
  for (let i = next.length - 1; i >= 0; i--) {
    const b = next[i];
    if (b.kind === "thinking" && b.streaming) {
      if (!hasVisibleThinkingText(b.text)) {
        next.splice(i, 1);
        continue;
      }
      next[i] = {
        ...b,
        streaming: false,
        durationMs: b.startedAtMs ? Date.now() - b.startedAtMs : undefined,
      };
    }
  }
  return next;
}

// axe:reprise — the live text/thinking blocks at the end of the view
// (ids `s-a-` / `s-t-`): what the current model response has shown.
// axe:reprise-tour — never below `liveFrom` (start of the current turn): the
// final text of the previous turn also carries a live id when a continuation
// turn follows it with nothing in between.
function dropLiveResponse(blocks: ChatBlock[], liveFrom = 0): ChatBlock[] {
  let end = blocks.length;
  while (end > Math.max(0, liveFrom)) {
    const b = blocks[end - 1];
    const live =
      (b.kind === "assistant-text" && b.id.startsWith("s-a-")) ||
      (b.kind === "thinking" && b.id.startsWith("s-t-"));
    if (!live) break;
    end--;
  }
  return end === blocks.length ? blocks : blocks.slice(0, end);
}

function withStreamPhase(
  state: ChatViewState,
  streamPhase: StreamPhase,
  patch: Partial<ChatViewState> = {},
): ChatViewState {
  return {
    ...state,
    ...patch,
    streamPhase,
  };
}

export function applyEvent(
  state: ChatViewState,
  event: AgentEvent,
): ChatViewState {
  switch (event.type) {
    case "turn_started": {
      // axe:reprise-tour — un nouveau tour commence ici, même enchaîné au précédent.
      const next = beginTurn(state);
      return { ...next, liveFrom: next.blocks.length };
    }

    case "text_started": {
      const next = finalizeStreamingThinking(state.blocks);
      next.push({ kind: "assistant-text", id: `s-a-${Date.now()}`, text: "" });
      return withStreamPhase(state, "responding", { blocks: next });
    }
    case "text_chunk": {
      const next = state.blocks.slice();
      const last = next[next.length - 1];
      if (last && last.kind === "assistant-text") {
        next[next.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        next.push({
          kind: "assistant-text",
          id: `s-a-${Date.now()}`,
          text: event.delta,
        });
      }
      return withStreamPhase(state, "responding", { blocks: next });
    }
    case "text_finished":
      return state;

    // axe:reprise — stream cut, the request is sent again: the response
    // starts over, what it had shown goes away.
    case "stream_retry":
      return withStreamPhase(state, "waiting", {
        blocks: dropLiveResponse(state.blocks, state.liveFrom),
      });

    case "thinking_started": {
      return withStreamPhase(state, "thinking");
    }
    case "thinking_chunk": {
      if (!event.delta) return withStreamPhase(state, "thinking");
      const next = state.blocks.slice();
      const last = next[next.length - 1];
      if (last && last.kind === "thinking" && last.streaming) {
        next[next.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        next.push({
          kind: "thinking",
          id: `s-t-${Date.now()}`,
          text: event.delta,
          streaming: true,
          startedAtMs: Date.now(),
        });
      }
      return withStreamPhase(state, "thinking", { blocks: next });
    }
    case "thinking_finished": {
      const next = state.blocks.slice();
      for (let i = next.length - 1; i >= 0; i--) {
        const b = next[i];
        if (b.kind === "thinking" && b.streaming) {
          if (!hasVisibleThinkingText(b.text)) {
            next.splice(i, 1);
            break;
          }
          next[i] = {
            ...b,
            streaming: false,
            durationMs: b.startedAtMs ? Date.now() - b.startedAtMs : undefined,
          };
          break;
        }
      }
      return withStreamPhase(state, "thinking", { blocks: next });
    }

    case "tool_started": {
      const next = finalizeStreamingThinking(state.blocks);
      if (event.name === "context_compaction") {
        next.push({
          kind: "compaction-summary",
          id: liveCompactionBlockId(event.id),
          text: "",
          historyIndex: -1,
          streaming: true,
        });
        return withStreamPhase(state, "tooling", { blocks: next });
      }
      next.push({
        kind: "tool",
        id: event.id,
        name: event.name,
        status: "running",
        hidden: event.name === "bash_input" ? true : undefined,
        summary: pendingSummary(event.name),
        answered: isToolName(event.name, "question") ? false : undefined,
        subAgent: isSubAgentLikeTool(event.name)
          ? { id: event.id, name: isToolName(event.name, "agent") ? "Agent" : "Sous-agent" }
          : undefined,
      });
      return withStreamPhase(state, "tooling", { blocks: next });
    }
    case "tool_output_delta": {
      // axe:repl — live stdout of a regular tool (python REPL): append it to
      // the tool card. Only compaction deltas create a compaction block;
      // treating every delta as compaction showed "Compacted context" cards
      // for each python execution.
      const toolIndex = state.blocks.findIndex(
        (block) => block.kind === "tool" && block.id === event.id,
      );
      if (toolIndex >= 0) {
        const next = state.blocks.slice();
        const block = next[toolIndex];
        if (block.kind === "tool" && block.name !== "context_compaction") {
          next[toolIndex] = { ...block, output: `${block.output ?? ""}${event.delta}` };
          return withStreamPhase(state, "tooling", { blocks: next });
        }
      }
      const index = liveCompactionBlockIndex(state.blocks, event.id);
      const next = state.blocks.slice();
      if (index >= 0) {
        const block = next[index];
        if (block.kind === "compaction-summary") {
          next[index] = {
            ...block,
            text: block.text + event.delta,
            streaming: true,
          };
        }
      } else {
        next.push({
          kind: "compaction-summary",
          id: liveCompactionBlockId(event.id),
          text: event.delta,
          historyIndex: -1,
          streaming: true,
        });
      }
      return withStreamPhase(state, "tooling", { blocks: next });
    }
    case "tool_ready": {
      const next = state.blocks.map((block) => {
        if (block.kind === "tool" && block.id === event.id) {
          const input = parsePrettyJson(event.args_pretty);
          const silentBashPoll = silentBashPollInfo(block.name, input);
          return {
            ...block,
            hidden:
              block.name === "bash_input"
                ? bashInputShouldStayHidden(input, false)
                : silentBashPoll
                  ? true
                  : block.hidden,
            summary: resumeOutilEnFrancais(block.name, event.summary),
            argsPretty: input ? prettyToolInput(block.name, input) : event.args_pretty,
            argsRaw: undefined,
            liveFileChange:
              block.name === "write_file"
                ? liveWriteFileChangeFromInput(input) ?? block.liveFileChange
                : block.liveFileChange,
            subAgent: isSubAgentLikeTool(block.name)
              ? {
                  ...(block.subAgent ?? { id: block.id, name: "Sous-agent" }),
                  name: subAgentNameFromSummary(event.summary) ?? block.subAgent?.name ?? "Sous-agent",
                }
              : block.subAgent,
          };
        }
        return block;
      });
      return withStreamPhase(state, "tooling", { blocks: next });
    }
    case "tool_args_delta": {
      const next = state.blocks.map((block) => {
        if (block.kind !== "tool" || block.id !== event.id) return block;
        const argsRaw = `${block.argsRaw ?? ""}${event.delta}`;
        const parsedInput = parsePrettyJson(argsRaw);
        const partialInput =
          parsedInput && typeof parsedInput === "object"
            ? (parsedInput as Record<string, unknown>)
            : partialArgsFromToolJson(block.name, argsRaw);
        const liveFileChange =
          block.name === "write_file"
            ? liveWriteFileChangeFromInput(partialInput) ?? block.liveFileChange
            : block.liveFileChange;
        return {
          ...block,
          hidden:
            block.name === "bash_input"
              ? bashInputShouldStayHidden(partialInput, block.hidden ?? true)
              : block.hidden,
          argsRaw,
          argsPretty: partialInput
            ? prettyToolInput(block.name, partialInput)
            : block.argsPretty,
          liveFileChange,
          summary: partialInput
            ? summaryFromInput(block.name, partialInput) ?? block.summary
            : block.summary,
        };
      });
      return withStreamPhase(state, "tooling", { blocks: next });
    }
    case "tool_finished": {
      const finishedBlock = state.blocks.find(
        (block): block is Extract<ChatBlock, { kind: "tool" }> =>
          block.kind === "tool" && block.id === event.id,
      );
      const hiddenBashPoll =
        finishedBlock?.hidden && (finishedBlock.argsPretty || finishedBlock.argsRaw)
          ? silentBashPollInfo(
              finishedBlock.name,
              parsePrettyJson(finishedBlock.argsPretty ?? finishedBlock.argsRaw ?? ""),
            )
          : null;
      if (hiddenBashPoll) {
        const result: ToolResultPart = {
          type: "tool_result",
          tool_call_id: event.id,
          content: event.output,
          images: event.images,
          is_error: event.is_error,
          meta: event.meta,
        };
        const filtered = state.blocks.filter(
          (block) => !(block.kind === "tool" && block.id === event.id),
        );
        const targetIndex = findBashSessionBlockIndex(
          filtered,
          hiddenBashPoll.sessionId,
        );
        if (targetIndex >= 0) {
          const target = filtered[targetIndex];
          if (target.kind === "tool") {
            filtered[targetIndex] = mergeBashPollResult(
              target,
              result,
              hiddenBashPoll.sessionId,
            );
          }
          return withStreamPhase(state, "waiting", { blocks: filtered });
        }
        if (!event.is_error) {
          return withStreamPhase(state, "waiting", { blocks: filtered });
        }
      }
      const liveCompactionIndex = liveCompactionBlockIndex(state.blocks, event.id);
      const isContextCompactionFinished =
        liveCompactionIndex >= 0 || finishedBlock?.name === "context_compaction";
      if (isContextCompactionFinished) {
        if (event.is_error) {
          const errorBlock: Extract<ChatBlock, { kind: "tool" }> = {
            kind: "tool",
            id: event.id,
            name: "context_compaction",
            status: "error",
            summary: "Compacter le contexte",
            argsPretty: "{}",
            output: event.output,
            isError: true,
            meta: event.meta,
          };
          const next = state.blocks.map((block) => {
            if (block.kind === "compaction-summary" && block.id === liveCompactionBlockId(event.id)) {
              return errorBlock;
            }
            if (block.kind === "tool" && block.id === event.id) return errorBlock;
            return block;
          });
          return withStreamPhase(state, "waiting", { blocks: next });
        }

        const liveCompactionSummary = compactionSummaryFromToolMeta(event.meta);
        let replaced = false;
        const next = state.blocks.map((block) => {
          if (block.kind === "compaction-summary" && block.id === liveCompactionBlockId(event.id)) {
            replaced = true;
            return {
              ...block,
              text: liveCompactionSummary ?? block.text,
              streaming: false,
            };
          }
          if (block.kind === "tool" && block.id === event.id) {
            replaced = true;
            return {
              kind: "compaction-summary" as const,
              id: liveCompactionBlockId(event.id),
              text: liveCompactionSummary ?? "",
              historyIndex: -1,
              streaming: false,
            };
          }
          return block;
        });
        if (!replaced) {
          next.push({
            kind: "compaction-summary",
            id: liveCompactionBlockId(event.id),
            text: liveCompactionSummary ?? "",
            historyIndex: -1,
            streaming: false,
          });
        }
        return withStreamPhase(state, "waiting", { blocks: next });
      }
      const cleanupBlock = state.blocks.find(
        (block): block is Extract<ChatBlock, { kind: "tool" }> =>
          block.kind === "tool" &&
          block.id === event.id &&
          block.name === "clean_context",
      );
      const cleanedIds =
        cleanupBlock && !event.is_error
          ? cleanContextIdsFromArgs(cleanupBlock.argsPretty)
          : new Set<string>();
      const visibleBashInput =
        finishedBlock && (finishedBlock.argsPretty || finishedBlock.argsRaw)
          ? visibleBashInputInfo(
              finishedBlock.name,
              parsePrettyJson(finishedBlock.argsPretty ?? finishedBlock.argsRaw ?? ""),
            )
          : null;
      const visibleBashInputResult: ToolResultPart | null = visibleBashInput
        ? {
            type: "tool_result",
            tool_call_id: event.id,
            content: event.output,
            images: event.images,
            is_error: event.is_error,
            meta: event.meta,
          }
        : null;
      const visibleBashInputTargetIndex = visibleBashInput
        ? findBashSessionBlockIndex(
            state.blocks,
            visibleBashInput.sessionId,
            event.id,
          )
        : -1;
      const next = state.blocks.map((block, index) => {
        if (
          visibleBashInput &&
          visibleBashInputResult &&
          index === visibleBashInputTargetIndex &&
          block.kind === "tool"
        ) {
          return mergeBashPollResult(
            block,
            visibleBashInputResult,
            visibleBashInput.sessionId,
          );
        }
        if (
          block.kind === "tool" &&
          cleanedIds.has(block.id) &&
          block.id !== event.id
        ) {
          return {
            ...block,
            cleaned: true,
            output: CLEANED_TOOL_OUTPUT,
            images: undefined,
          };
        }
        if (block.kind === "tool" && block.id === event.id) {
          const images = Array.isArray(event.images) ? event.images : [];
          const hasFileChanges = event.file_changes.length > 0;
          const bashStillRunning =
            block.name === "bash" &&
            !event.is_error &&
            bashSessionIdFromOutput(event.output) !== null;
          const questionAnswered =
            isToolName(block.name, "question") ? !event.is_error : block.answered;
          return {
            ...block,
            hidden: false,
            status: event.is_error
              ? ("error" as const)
              : bashStillRunning
                ? ("running" as const)
                : ("done" as const),
            summary: block.summary,
            output: event.output,
            isError: event.is_error,
            answered: questionAnswered,
            answer:
              isToolName(block.name, "question")
                ? questionAnswerFromMeta(event.meta)
                : block.answer,
            fileChanges: hasFileChanges ? event.file_changes : block.fileChanges,
            liveFileChange: undefined,
            images: images.length > 0 ? images : block.images,
            meta: event.meta ?? block.meta,
          };
        }
        return block;
      });
      return withStreamPhase(state, "waiting", { blocks: next });
    }
    case "token_usage":
      return state;

    case "interrupted": {
      const blocks = state.blocks.map((block) => {
        if (block.kind === "tool" && block.status === "running") {
          const output =
            block.output && block.output.length > 0
              ? block.output
              : "Appel d'outil interrompu par l'utilisateur";
          return {
            ...block,
            status: "error" as const,
            isError: true,
            output,
            liveFileChange: undefined,
          };
        }
        return block;
      });
      return withStreamPhase(state, "idle", {
        status: "stopped",
        blocks,
      });
    }

    case "error":
      return withStreamPhase(state, "idle", {
        status: "stopped",
        lastError: event.message,
      });

    case "peer_message_received":
      return state;

    case "sub_agent_event":
      return state;

    case "agent_slept":
      return state;

    case "turn_finished": {
      const blocks = finalizeStreamingThinking(state.blocks);
      const eventDurationMs =
        typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms)
          ? event.duration_ms
          : null;
      const durationMs =
        eventDurationMs ??
        (state.turnStartedAtMs !== null ? Date.now() - state.turnStartedAtMs : 0);
      if (durationMs > MIN_VISIBLE_TURN_DURATION_MS) {
        blocks.push({
          kind: "turn-duration",
          id: `s-d-${Date.now()}`,
          durationMs,
        });
      }
      return withStreamPhase(state, "idle", {
        blocks,
        status: state.status === "stopped" ? "stopped" : "idle",
        turnStartedAtMs: null,
      });
    }
  }
}

function parsePrettyJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function beginTurn(state: ChatViewState): ChatViewState {
  if (state.status === "streaming" && state.streamPhase !== "idle") {
    return {
      ...state,
      status: "streaming",
      lastError: null,
      turnStartedAtMs: state.turnStartedAtMs ?? Date.now(),
    };
  }

  return withStreamPhase(state, "waiting", {
    status: "streaming",
    lastError: null,
    turnStartedAtMs: state.turnStartedAtMs ?? Date.now(),
    liveFrom: state.blocks.length, // axe:reprise-tour
  });
}

// Append a user message block to the view optimistically before we
// hear back from the backend.
export function appendUserMessage(
  state: ChatViewState,
  text: string,
  historyIndex: number,
  attachments?: UserAttachment[],
): ChatViewState {
  return {
    ...state,
    blocks: [
      ...state.blocks,
        {
          kind: "user-text",
          id: `u-${Date.now()}`,
          text,
          historyIndex,
          attachments:
            attachments && attachments.length > 0 ? attachments : undefined,
        },
      ],
  };
}

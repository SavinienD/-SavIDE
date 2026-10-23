import type {
  AgentMode,
  MessageVisibility,
  ModelRef,
  PlanArtifact,
  PlanControl,
  SavedConversation,
  ServiceTier,
  ThinkingLevel,
} from "../../types";

export type ConversationExecutors = {
  send: (
    conversation: SavedConversation,
    text: string,
    attachments: { path: string; name?: string }[],
    model: ModelRef,
    thinking: ThinkingLevel,
    mode: AgentMode,
    serviceTier?: ServiceTier | null,
    rewriteFromHistoryIndex?: number,
    planControl?: PlanControl,
    messageVisibility?: MessageVisibility,
    revertWorkspaceChanges?: boolean,
  ) => Promise<void>;
  compact: (
    conversation: SavedConversation,
    model: ModelRef,
    thinking: ThinkingLevel,
    serviceTier?: ServiceTier | null,
    options?: { continueAfter?: boolean; instruction?: string },
  ) => Promise<void>;
  changeMode: (conversation: SavedConversation, mode: AgentMode) => Promise<void>;
  changeModelPreference: (
    conversation: SavedConversation,
    mode: AgentMode,
    model: ModelRef,
    thinking: ThinkingLevel,
  ) => Promise<void>;
  implementPlanFresh: (
    conversation: SavedConversation,
    plan: PlanArtifact,
    prompt?: string,
  ) => Promise<void>;
  stop: (conversation: SavedConversation) => Promise<void>;
  /** axe:arriere-plan — le travail en cours part dans une session d'arrière-plan. */
  background?: (conversation: SavedConversation) => Promise<{ id: string; nom: string }>;
};

export type ConversationActions = {
  onSend: (
    text: string,
    attachments: { path: string; name?: string }[],
    model: ModelRef,
    thinking: ThinkingLevel,
    mode: AgentMode,
    serviceTier?: ServiceTier | null,
    rewriteFromHistoryIndex?: number,
    planControl?: PlanControl,
    messageVisibility?: MessageVisibility,
    revertWorkspaceChanges?: boolean,
  ) => Promise<void>;
  onCompact: (
    model: ModelRef,
    thinking: ThinkingLevel,
    serviceTier?: ServiceTier | null,
    options?: { continueAfter?: boolean; instruction?: string },
  ) => Promise<void>;
  onModeChange: (mode: AgentMode) => Promise<void>;
  onModelPreferenceChange: (
    mode: AgentMode,
    model: ModelRef,
    thinking: ThinkingLevel,
  ) => Promise<void>;
  onImplementPlanFresh: (plan: PlanArtifact, prompt?: string) => Promise<void>;
  onStop: () => Promise<void>;
  onBackground?: () => Promise<{ id: string; nom: string }>;
};

/** Lie chaque callback à une conversation précise, sans état global "active". */
export function createConversationActions(
  conversation: SavedConversation,
  executors: ConversationExecutors,
): ConversationActions {
  return {
    onSend: (...args) => executors.send(conversation, ...args),
    onCompact: (...args) => executors.compact(conversation, ...args),
    onModeChange: (mode) => executors.changeMode(conversation, mode),
    onModelPreferenceChange: (mode, model, thinking) =>
      executors.changeModelPreference(conversation, mode, model, thinking),
    onImplementPlanFresh: (plan, prompt) =>
      executors.implementPlanFresh(conversation, plan, prompt),
    onStop: () => executors.stop(conversation),
    onBackground: executors.background
      ? () => executors.background!(conversation)
      : undefined,
  };
}

import type {
  AgentCatalogRefresh,
  AgentInstallation,
  AgentKind,
  AgentProfile,
  SubscriptionUsage,
  OlderHistory,
  PermissionMenu,
  ReviewTargets,
  Session,
  SessionEvent,
} from "@/types";
import { invoke } from "./call";
import type { Backend, CreateAndSendInput, CreateAndSendResult } from "./contract";

export const sessionCommands: Pick<
  Backend,
  | "listSessions"
  | "forkSession"
  | "renameSession"
  | "setSessionArchived"
  | "deleteSession"
  | "sessionWorktreeDeletePreview"
  | "createSession"
  | "createSessionAndSend"
  | "cancelSessionStart"
  | "discardUnsentSession"
  | "cachedAgentCatalog"
  | "agentPermissionMenu"
  | "setSandbox"
  | "permissionMenu"
  | "agentProfiles"
  | "subscriptionUsage"
  | "listAgentInstallations"
  | "updateAgent"
  | "agentCatalog"
  | "setSessionTuning"
  | "setSessionServiceTier"
  | "sendMessage"
  | "sendMessageNow"
  | "submitAnnotation"
  | "updateQueuedTurn"
  | "removeQueuedTurn"
  | "steerQueuedTurn"
  | "flushQueuedTurns"
  | "setFollowUpQueueMode"
  | "sessionQueue"
  | "interruptTurn"
  | "stageChatImage"
  | "setCollaborationMode"
  | "setThreadGoal"
  | "clearThreadGoal"
  | "setThreadGoalStatus"
  | "publishThreadGoal"
  | "reviewTargets"
  | "startReview"
  | "answerPrompt"
  | "stopSession"
  | "getSessionEvents"
  | "loadOlderHistory"
> = {
  listSessions: (projectId) => invoke<Session[]>("list_sessions", { projectId }),
  forkSession: (sessionId) => invoke<Session>("fork_session", { sessionId }),
  renameSession: (sessionId, name) =>
    invoke("rename_session", { sessionId, name }),
  setSessionArchived: (sessionId, archived) =>
    invoke("set_session_archived", { sessionId, archived }),
  deleteSession: (sessionId, options) =>
    invoke("delete_session", {
      sessionId,
      discardWorktree: options?.discardWorktree ?? false,
      forceWorktree: options?.forceWorktree ?? false,
    }),
  sessionWorktreeDeletePreview: (sessionId) =>
    invoke("session_worktree_delete_preview", { sessionId }),
  createSession: (projectId, agent, accessMode) =>
    invoke<Session>("create_session", {
      projectId,
      agent: agent ?? null,
      accessMode: accessMode ?? null,
    }),
  createSessionAndSend: (input: CreateAndSendInput) =>
    invoke<CreateAndSendResult>("create_session_and_send", { input }),
  cancelSessionStart: (projectId) => invoke("cancel_session_start", { projectId }),
  discardUnsentSession: (sessionId) =>
    invoke("discard_unsent_session", { sessionId }),
  cachedAgentCatalog: (agent) =>
    invoke<AgentCatalogRefresh>("cached_agent_catalog", { agent }),
  agentPermissionMenu: (agent) =>
    invoke<PermissionMenu>("agent_permission_menu", { agent }),
  setSandbox: (sessionId, sandbox) =>
    invoke("set_session_access", {
      sessionId,
      mode: sandbox.profileId ? "ask" : sandbox.mode,
      networkAccess: sandbox.networkAccess,
      writableRoots: sandbox.writableRoots,
      profileId: sandbox.profileId,
    }),
  permissionMenu: (sessionId) =>
    invoke<PermissionMenu>("session_permission_menu", { sessionId }),
  agentProfiles: () => invoke<AgentProfile[]>("agent_profiles"),
  subscriptionUsage: (kind: AgentKind) =>
    invoke<SubscriptionUsage>("subscription_usage", { kind }),
  listAgentInstallations: () =>
    invoke<AgentInstallation[]>("list_agent_installations"),
  updateAgent: (kind) => invoke<AgentInstallation>("update_agent", { kind }),
  agentCatalog: (sessionId) =>
    invoke<AgentCatalogRefresh>("agent_catalog", { sessionId }),
  setSessionTuning: (sessionId, model, effort) =>
    invoke("set_session_tuning", { sessionId, model, effort }),
  setSessionServiceTier: (sessionId, serviceTier) =>
    invoke("set_session_service_tier", { sessionId, serviceTier }),
  sendMessage: (sessionId, text, images, annotations) =>
    invoke("send_message", {
      sessionId,
      text,
      images: images ?? [],
      annotations: annotations ?? [],
    }),
  sendMessageNow: (sessionId, text, images, annotations) =>
    invoke("send_message_now", {
      sessionId,
      text,
      images: images ?? [],
      annotations: annotations ?? [],
    }),
  submitAnnotation: (sessionId, note) =>
    invoke("submit_annotation", { sessionId, note }),
  updateQueuedTurn: (sessionId, queuedId, text, images) =>
    invoke("update_queued_turn", {
      sessionId,
      queuedId,
      text,
      images: images ?? [],
    }),
  removeQueuedTurn: (sessionId, queuedId) =>
    invoke("remove_queued_turn", { sessionId, queuedId }),
  steerQueuedTurn: (sessionId, queuedId) =>
    invoke("steer_queued_turn", { sessionId, queuedId }),
  flushQueuedTurns: (sessionId, queuedIds) =>
    invoke("flush_queued_turns", { sessionId, queuedIds }),
  setFollowUpQueueMode: (sessionId, mode) =>
    invoke("set_follow_up_queue_mode", { sessionId, mode }),
  sessionQueue: (sessionId) =>
    invoke("session_queue", { sessionId }),
  interruptTurn: (sessionId) => invoke("interrupt_turn", { sessionId }),
  stageChatImage: (dataBase64, name) =>
    invoke("stage_chat_image", { dataBase64, name }),
  setCollaborationMode: (sessionId, mode) =>
    invoke("set_collaboration_mode", { sessionId, mode }),
  setThreadGoal: (sessionId, objective) =>
    invoke("set_thread_goal", { sessionId, objective }),
  clearThreadGoal: (sessionId) => invoke("clear_thread_goal", { sessionId }),
  setThreadGoalStatus: (sessionId, status) =>
    invoke("set_thread_goal_status", { sessionId, status }),
  publishThreadGoal: (sessionId) => invoke("publish_thread_goal", { sessionId }),
  reviewTargets: (sessionId) =>
    invoke<ReviewTargets>("review_targets", { sessionId }),
  startReview: (sessionId, target) =>
    invoke("start_review", { sessionId, target }),
  answerPrompt: (sessionId, promptId, answer) =>
    invoke("answer_prompt", { sessionId, promptId, answer }),
  stopSession: (sessionId) => invoke("stop_session", { sessionId }),
  getSessionEvents: (sessionId) =>
    invoke<SessionEvent[]>("get_session_events", { sessionId }),
  loadOlderHistory: (sessionId) =>
    invoke<OlderHistory>("load_older_history", { sessionId }),
};

// 样例页用的会话视图：和真实会话同一套时间线、作曲栏、面板，数据是写死的，不连 daemon。
// 动作都不生效；面板读文件时直接说预览里没有文件。

import { useMemo } from "react";

import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { Composer } from "@/features/chat/composer/Composer";
import type { ComposerHost } from "@/features/chat/composer/host";
import { ChatHostProvider, type ChatHost } from "@/features/chat/host";
import { ChatView } from "@/features/chat/timeline/ChatView";
import { PanelHost, type PanelData, type PanelStateSource } from "@/features/panel/core/PanelProvider";
import { SessionSplit } from "@/features/panel/core/SessionSplit";
import { usePanelStore } from "@/features/panel/state/store";
import { accumulateSessionUsage } from "@/store/session-usage";
import type { AgentCatalog, AgentKind, AgentProfile, PermissionMenu, Session, SessionEvent } from "@/types";

const NO_FILES = () => Promise.reject(new Error("预览里没有文件"));

const panelState: PanelStateSource = {
  use: (select) => usePanelStore(select),
  get: () => usePanelStore.getState(),
};

const previewPanelData: PanelData = {
  diffScopes: async () => [],
  diffForScope: NO_FILES,
  readPreviewFile: NO_FILES,
  readPreviewImage: NO_FILES,
  listDir: NO_FILES,
  filterPaths: NO_FILES,
  searchFiles: NO_FILES,
  openFile: NO_FILES,
  prepareBrowserFile: NO_FILES,
  submitAnnotation: async () => {},
  attachFile: () => {},
  addTextSnippet: () => {},
  textSnippets: { subscribe: () => () => {}, read: () => [] },
  removeTextSnippet: () => {},
  isGit: async () => false,
  openTerminal: NO_FILES,
  subscriptionUsage: NO_FILES,
};

export function previewComposerHost(input: {
  profile?: AgentProfile;
  catalog?: AgentCatalog;
  permissionMenu?: PermissionMenu | null;
}): ComposerHost {
  return {
    draft: false,
    inputLocked: false,
    initialText: "",
    initialFileRefs: [],
    catalog: input.catalog,
    catalogNotice: null,
    profile: input.profile,
    tuning: undefined,
    sandbox: null,
    permissionMenu: input.permissionMenu ?? null,
    projectPath: "",
    files: [],
    snippets: [],
    queue: [],
    followUpQueueMode: "queue",
    git: null,
    workContext: null,
    worktree: null,
    agentChoice: null,
    rememberText: () => {},
    rememberFileRefs: () => {},
    send: async () => true,
    setCollaborationMode: async () => {},
    startReview: async () => {},
    reviewTargets: NO_FILES,
    answerPrompt: async () => true,
    setSandbox: () => {},
    setTuning: () => {},
    addAttachments: () => {},
    removeAttachment: () => {},
    clearAttachments: () => {},
    replaceAttachments: () => {},
    clearTextSnippets: () => {},
    removeTextSnippet: () => {},
    updateQueued: async () => {},
    removeQueued: async () => {},
    steerQueued: async () => {},
    flushQueued: async () => {},
    setFollowUpQueueMode: () => {},
    interrupt: () => {},
    setGoal: async () => {},
    clearGoal: async () => {},
    setGoalStatus: async () => {},
    publishGoal: async () => {},
    filterPaths: async () => ({ paths: [], truncated: false, cancelled: false, ready: true }),
    reportError: () => {},
  };
}

export function PreviewSession({
  session,
  events,
  profiles = {},
  panel = true,
  subtasks,
}: {
  session: Session;
  events: SessionEvent[];
  profiles?: Partial<Record<AgentKind, AgentProfile>>;
  /** 带右侧面板。 */
  panel?: boolean;
  subtasks?: ChatHost["subtasks"];
}) {
  const chatHost = useMemo<ChatHost>(
    () => ({ answerPrompt: async () => true, profiles, projectPath: "", addTextSnippet: () => {}, subtasks }),
    [profiles, subtasks],
  );
  const composer = useMemo(() => previewComposerHost({ profile: profiles[session.agent] }), [profiles, session.agent]);
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  const chat = (
    <ChatView
      session={session}
      events={events}
      renderComposer={(anchorRef) => (
        <Composer host={composer} session={session} events={events} anchorRef={anchorRef} />
      )}
    />
  );
  const profile = profiles[session.agent];
  return (
    <ChatHostProvider host={chatHost}>
      {panel ? (
        <PanelHost
          state={panelState}
          data={previewPanelData}
          changes={profile?.capabilities.changes}
          status={session.status}
          subscriptionSupported={Boolean(profile?.capabilities.supports_subscription_usage)}
          sessionId={session.id}
          projectId={session.project_id}
          projectPath=""
          sessionTitle={session.title}
          agent={session.agent}
          events={events}
          usage={usage}
        >
          <AnswerMarkdownHost>
            <SessionSplit>{chat}</SessionSplit>
          </AnswerMarkdownHost>
        </PanelHost>
      ) : (
        <AnswerMarkdownHost>{chat}</AnswerMarkdownHost>
      )}
    </ChatHostProvider>
  );
}

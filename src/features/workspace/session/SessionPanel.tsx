// 会话的右侧面板：差异、文件、搜索、内置浏览器。界面状态在独立的面板 store，文件数据走 daemon；
// 用系统程序打开、浏览器加载本地文件这些本机能力走应用壳。还没建会话时按项目主目录读。

import { useMemo, type ReactNode } from "react";

import { PanelHost, type PanelData, type PanelStateSource } from "@/features/panel/core/PanelProvider";
import { usePanelStore } from "@/features/panel/state/store";
import { openPath, prepareBrowserPath } from "@/lib/native/open-path";
import { accumulateSessionUsage } from "@/store/session-usage";
import type { OpenTarget } from "@/features/panel/core/registry";
import type { AgentProfile, Session, SessionEvent } from "@/types";
import * as api from "./api";
import { addDraftAttachments, addDraftSnippet } from "./composer-drafts";

const panelState: PanelStateSource = {
  use: (select) => usePanelStore(select),
  get: () => usePanelStore.getState(),
};

/** 文件类调用按范围找目录：建好的会话按会话，新会话按项目。 */
function panelData(scope: api.FileScope, workdir: string): PanelData {
  return {
    diffScopes: () => api.diffScopes(scope),
    diffForScope: (_sessionId, diffScope, ignoreWhitespace) => api.diffForScope(scope, diffScope, ignoreWhitespace),
    readPreviewFile: (_projectId, path) => api.readFile(scope, path),
    readPreviewImage: (_projectId, path) => api.readImage(scope, path),
    listDir: (_projectId, dir) => api.listDir(scope, dir),
    filterPaths: (_projectId, query) => api.filterPaths(scope, query),
    searchFiles: (_projectId, query, mask, searchId) => api.searchFiles(scope, query, mask, searchId),
    openFile: (_projectId, path, mode) => openPath(workdir, path, mode),
    prepareBrowserFile: (_projectId, path) => prepareBrowserPath(workdir, path),
    submitAnnotation: (sessionId, note) => api.submitAnnotation(sessionId, note).then(() => undefined),
    attachFile: (sessionId, file) => addDraftAttachments(sessionId, [file]),
    addTextSnippet: addDraftSnippet,
    isGit: () => api.isGitScope(scope),
    openTerminal: (cols, rows) => api.openTerminal(scope, cols, rows),
    subscriptionUsage: api.subscriptionUsage,
  };
}

export function SessionPanel({
  session,
  scope,
  workdir,
  events,
  profile,
  sideChat = null,
  children,
}: {
  session: Session;
  scope: api.FileScope;
  workdir: string;
  events: SessionEvent[];
  profile: AgentProfile | undefined;
  /** 能开侧边聊天时给出它的标签目标。 */
  sideChat?: OpenTarget | null;
  children: ReactNode;
}) {
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  const scopeKey = "sessionId" in scope ? scope.sessionId : scope.projectId;
  const data = useMemo(() => panelData(scope, workdir), [scopeKey, workdir]);
  return (
    <PanelHost
      state={panelState}
      data={data}
      changes={profile?.capabilities.changes}
      status={session.status}
      subscriptionSupported={Boolean(profile?.capabilities.supports_subscription_usage)}
      sessionId={session.id}
      projectId={session.project_id}
      projectPath={workdir}
      sessionTitle={session.title}
      agent={session.agent}
      events={events}
      usage={usage}
      sideChat={sideChat}
    >
      {children}
    </PanelHost>
  );
}

/** 只按项目主目录读的面板，没有会话。开发样例页用。 */
export function ProjectPanel({
  projectId,
  path,
  title,
  events = [],
  children,
}: {
  projectId: string;
  path: string;
  title: string;
  events?: SessionEvent[];
  children: ReactNode;
}) {
  const session = useMemo<Session>(
    () => ({
      id: `project:${projectId}`,
      project_id: projectId,
      agent: "codex-cli",
      native_id: "",
      title,
      status: "completed",
      created_at: 0,
      updated_at: 0,
    }),
    [projectId, title],
  );
  return (
    <SessionPanel session={session} scope={{ projectId }} workdir={path} events={events} profile={undefined}>
      {children}
    </SessionPanel>
  );
}

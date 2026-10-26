// 任务的右侧面板：差异、文件、搜索、内置浏览器。状态在独立的面板 store，文件数据走 daemon，
// 用系统程序打开、浏览器加载本地文件这些本机能力走应用壳。

import { useMemo, type ReactNode } from "react";

import { PanelHost, type PanelData, type PanelStateSource } from "@/features/panel/core/PanelProvider";
import { usePanelStore } from "@/features/panel/state/store";
import { openPath, prepareBrowserPath } from "@/lib/native/open-path";
import { accumulateSessionUsage } from "@/store/session-usage";
import type { AgentProfile, Session, SessionEvent } from "@/types";
import { addTaskAttachments, addTaskSnippet } from "./task-composer-store";
import {
  diffForScope,
  diffScopes,
  filterSessionPaths,
  isGitWorkdir,
  listSessionDir,
  readSessionFile,
  readSessionImage,
  searchSessionFiles,
  submitAnnotation,
  subscriptionUsage,
} from "./task-backend";

const panelState: PanelStateSource = {
  use: (select) => usePanelStore(select),
  get: () => usePanelStore.getState(),
};

/** 文件类调用按会话找工作目录，项目 id 用不到。 */
function panelData(workdir: string): PanelData {
  return {
    diffScopes,
    diffForScope,
    readPreviewFile: (_projectId, path, sessionId) => readSessionFile(sessionId, path),
    readPreviewImage: (_projectId, path, sessionId) => readSessionImage(sessionId, path),
    listDir: (_projectId, dir, sessionId) => listSessionDir(sessionId, dir),
    filterPaths: (_projectId, query, sessionId) => filterSessionPaths(sessionId, query),
    searchFiles: (_projectId, query, mask, searchId, sessionId) =>
      searchSessionFiles(sessionId, query, mask, searchId),
    openFile: (_projectId, path, mode) => openPath(workdir, path, mode),
    prepareBrowserFile: (_projectId, path) => prepareBrowserPath(workdir, path),
    submitAnnotation: (sessionId, note) => submitAnnotation(sessionId, note).then(() => undefined),
    attachFile: (sessionId, file) => addTaskAttachments(sessionId, [file]),
    addTextSnippet: addTaskSnippet,
    isGit: (_projectId, sessionId) => isGitWorkdir(sessionId),
    subscriptionUsage,
  };
}

export function TaskPanel({
  session,
  events,
  projectPath,
  profile,
  children,
}: {
  session: Session;
  events: SessionEvent[];
  projectPath: string;
  profile: AgentProfile | undefined;
  children: ReactNode;
}) {
  const usage = useMemo(() => accumulateSessionUsage(events), [events]);
  const workdir = session.workdir?.trim() || projectPath;
  const data = useMemo(() => panelData(workdir), [workdir]);
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
      sessionTitle={session.title.trim() || "新任务"}
      agent={session.agent}
      events={events}
      usage={usage}
    >
      {children}
    </PanelHost>
  );
}

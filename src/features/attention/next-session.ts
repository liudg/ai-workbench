import type { Project, Session, SessionEvent, SessionStatus } from "../../types/index.ts";
import { isDraftId, isPendingId } from "../../store/draft-session.ts";
import { isFinishedStatus } from "../../shared/unread-finished.ts";
import { standaloneChatSessions } from "../../store/standalone.ts";
import { pendingApprovalEvent } from "../chat/events/pending-approval.ts";
import { pendingQuestionEvent } from "../chat/events/pending-question.ts";
import { splitPinnedProjects } from "../sidebar/projects/project-sections.ts";
import { orderSidebarSessions } from "../sidebar/sessions/session-order.ts";
import { partitionSidebarSessions } from "../sidebar/sessions/session-partition.ts";

/**
 * 命令 id `nextThreadNeedingAttention` 已观察到。
 * zh-CN 摘录里没有这条菜单原文，文案用工作台说法。
 * 没有下一条时的提示、以及绕回顺序，都未观察。
 */
export const NEXT_ATTENTION_COPY = {
  command: "下一个需要处理的聊天",
  none: "没有需要处理的聊天",
} as const;

export interface AttentionTarget {
  id: string;
  projectId: string;
}

export interface AttentionInput {
  projects: readonly Project[];
  pinnedProjectIds: readonly string[];
  sessions: Readonly<Record<string, readonly Session[] | undefined>>;
  pinnedSessionIds: readonly string[];
  events: Readonly<Record<string, readonly SessionEvent[] | undefined>>;
  eventsReady: Readonly<Record<string, boolean | undefined>>;
  unreadFinishedIds: readonly string[];
  currentId: string | null;
}

/**
 * 侧栏看得见的顺序：置顶项目、其余项目，然后是聊天分组。
 * 归档和还没创建出来的草稿不进这条队列。
 */
export function attentionSessionOrder(input: {
  projects: readonly Project[];
  pinnedProjectIds: readonly string[];
  sessions: Readonly<Record<string, readonly Session[] | undefined>>;
  pinnedSessionIds: readonly string[];
}): AttentionTarget[] {
  const visible = input.projects.filter((project) => !project.standalone);
  const { pinned, unpinned } = splitPinnedProjects(visible, input.pinnedProjectIds);
  const targets: AttentionTarget[] = [];
  for (const project of [...pinned, ...unpinned]) {
    for (const session of orderedProjectSessions(input.sessions[project.id], input.pinnedSessionIds)) {
      targets.push({ id: session.id, projectId: project.id });
    }
  }
  const chats = standaloneChatSessions(input.projects, input.sessions);
  for (const session of orderedProjectSessions(chats, input.pinnedSessionIds)) {
    targets.push({ id: session.id, projectId: session.project_id });
  }
  return targets;
}

/**
 * 要处理：未读的已结束回合、待审批、待提问。三者同一队列，不另排名。
 * 事件还没读到本地时，用会话上已有的 needs-input（适配器标的在等批准或用户输入）。
 */
export function sessionNeedsAttention(input: {
  status: SessionStatus;
  unreadFinished: boolean;
  events: readonly SessionEvent[] | undefined;
  eventsReady: boolean;
}): boolean {
  if (input.unreadFinished && isFinishedStatus(input.status)) return true;
  const log = input.events;
  const hasLog = input.eventsReady || (log !== undefined && log.length > 0);
  if (!hasLog) return input.status === "needs-input";
  const events = log ?? [];
  if (pendingApprovalEvent(events, input.status)) return true;
  if (pendingQuestionEvent(events, input.status)) return true;
  return false;
}

/** 从当前会话往后找。当前这条不算下一个。到头绕回。没有别的就返回 null。 */
export function nextAttentionSession(
  ordered: readonly AttentionTarget[],
  needsAttention: (id: string) => boolean,
  currentId: string | null,
): AttentionTarget | null {
  if (ordered.length === 0) return null;
  const start = currentId ? ordered.findIndex((item) => item.id === currentId) : -1;
  const begin = start < 0 ? 0 : start + 1;
  for (let step = 0; step < ordered.length; step += 1) {
    const item = ordered[(begin + step) % ordered.length];
    if (!item || item.id === currentId || !needsAttention(item.id)) continue;
    return item;
  }
  return null;
}

export function nextAttentionTarget(input: AttentionInput): AttentionTarget | null {
  const ordered = attentionSessionOrder(input);
  const unread = new Set(input.unreadFinishedIds);
  const byId = new Map<string, Session>();
  for (const list of Object.values(input.sessions)) {
    for (const session of list ?? []) byId.set(session.id, session);
  }
  return nextAttentionSession(
    ordered,
    (id) => {
      const session = byId.get(id);
      if (!session) return false;
      return sessionNeedsAttention({
        status: session.status,
        unreadFinished: unread.has(session.id),
        events: input.events[session.id],
        eventsReady: input.eventsReady[session.id] === true,
      });
    },
    input.currentId,
  );
}

function orderedProjectSessions(
  list: readonly Session[] | undefined,
  pinnedSessionIds: readonly string[],
): Session[] {
  const active = partitionSidebarSessions(list ?? []).active.filter(
    (session) => !isPendingId(session.id) && !isDraftId(session.id),
  );
  return orderSidebarSessions(active, pinnedSessionIds);
}

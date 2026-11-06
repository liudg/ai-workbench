import { useEffect, useMemo, type ReactNode } from "react";
import { ArrowLeft, ArrowUpRight, Square } from "lucide-react";

import { useAgentProfiles } from "@/features/agents";
import { AnswerMarkdownHost } from "@/features/chat/answer/AnswerMarkdownHost";
import { CHAT_SCOPE_ATTR } from "@/features/chat/chat-scope";
import { Composer } from "@/features/chat/composer/Composer";
import { subagentTitle } from "@/features/chat/events/subagent-display";
import { subtaskStatus } from "@/features/chat/events/subtask-row";
import { useAgentIdentity, agentTurnName } from "@/features/chat/events/use-agent-identity";
import { ChatHostProvider } from "@/features/chat/host";
import { SubagentView } from "@/features/chat/subagent/SubagentView";
import { ChatView } from "@/features/chat/timeline/ChatView";
import type { ViewerViewProps } from "@/features/panel/core/registry";
import { useProjects } from "@/features/projects";
import { currentSession, useTasks, type TaskEntry, type TaskSession } from "@/features/tasks";
import { cn } from "@/lib/utils";
import { SessionAgentIcon } from "@/shared/agent/SessionAgentIcon";
import { agentIdentity } from "@/shared/agent/identity";
import { showError } from "@/shared/shell/error-banner";
import { openTask } from "@/shared/shell/navigation";
import type { AgentKind } from "@/types";
import { interruptTurn, stopSubagent } from "../session/api";
import { useLiveComposer } from "../session/use-live-composer";
import { useTaskChat } from "../session/use-task-chat";
import { focusSubagent, useSubagentFocus, type SubagentFocus } from "./open";
import type { SubagentRow } from "./subagent-rows";
import { subagentCards } from "./subagent-rows";
import { useSubagentRows } from "./use-subagent-rows";

/** 子智能体标签：这个会话开出的列表，点一行换成它的详情，返回回到列表。 */
export function SubagentsTab({ sessionId }: ViewerViewProps) {
  const { tasks } = useTasks();
  const focus = useSubagentFocus(sessionId);
  const owner = tasks.find((task) => task.sessions.some((session) => session.id === sessionId));
  const session = owner ? currentSession(owner) : undefined;
  if (!owner || !session) return null;
  return (
    <div data-subagents-tab className="flex h-full min-h-0 flex-col bg-[#0f0f0f]">
      {focus ? (
        <Detail key={focusKey(focus)} owner={sessionId} focus={focus} />
      ) : (
        <SubagentList owner={sessionId} task={owner} taskSession={session} />
      )}
    </div>
  );
}

function focusKey(focus: SubagentFocus): string {
  return focus.kind === "task" ? focus.taskId : `${focus.sessionId}:${focus.subagentId}`;
}

function SubagentList({ owner, task, taskSession }: { owner: string; task: TaskEntry; taskSession: TaskSession }) {
  const profiles = useAgentProfiles();
  const { items, stopAll } = useSubagentRows(task, taskSession, profiles[taskSession.agent]);
  if (items.length === 0) return <p className="px-4 py-6 text-sm text-zinc-500">还没有子智能体</p>;
  const running = items.some((item) => item.row.active && item.stop);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
      <div className="flex h-7 items-center px-2 text-[12px] text-[#8a8a8a]">
        <span className="min-w-0 flex-1 truncate">已开启 · {items.length}</span>
        {running ? (
          <button type="button" onClick={stopAll} className="rounded px-1.5 py-0.5 text-[#bdbdbd] hover:bg-white/[0.06] hover:text-white">
            全部停止
          </button>
        ) : null}
      </div>
      <ul className="m-0 list-none space-y-0.5 p-0">
        {items.map(({ row, focus, stop }) => (
          <Row
            key={row.key}
            row={row}
            profile={profiles[row.agent]}
            onOpen={() => focusSubagent(owner, focus)}
            onStop={row.active ? stop : undefined}
          />
        ))}
      </ul>
    </div>
  );
}

function Row({
  row,
  profile,
  onOpen,
  onStop,
}: {
  row: SubagentRow;
  profile: Parameters<typeof agentIdentity>[1];
  onOpen: () => void;
  onStop: (() => void) | undefined;
}) {
  return (
    <li data-subagent-row={row.key} className="group/row relative min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-white/[0.04]"
      >
        <SessionAgentIcon identity={agentIdentity(row.agent, profile)} className="mt-0.5 h-4 w-4" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-[#e4e4e4]">{row.title}</span>
          <span className="block truncate text-[12px] leading-5 text-[#8a8a8a]">
            <span className={row.statusClass}>{row.status}</span>
            {row.detail ? ` · ${row.detail}` : ""}
          </span>
        </span>
      </button>
      {onStop ? (
        <button
          type="button"
          title="停止"
          aria-label={`停止 ${row.title}`}
          onClick={onStop}
          className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded text-[#8a8a8a] opacity-0 hover:bg-white/[0.08] hover:text-[#ddd] focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          <Square className="h-3 w-3" />
        </button>
      ) : null}
    </li>
  );
}

function Detail({ owner, focus }: { owner: string; focus: SubagentFocus }) {
  const { tasks } = useTasks();
  const { projects } = useProjects();
  const task = tasks.find((item) => item.id === focus.taskId && !item.archivedAt);
  const taskSession = task ? currentSession(task) : undefined;
  // 删掉或归档了，回到列表。
  const gone = !task || !taskSession;
  useEffect(() => {
    if (gone) focusSubagent(owner, undefined);
  }, [gone, owner]);
  if (gone) return null;
  const project = task.projectId ? projects.find((item) => item.id === task.projectId) : undefined;
  return (
    <div {...{ [CHAT_SCOPE_ATTR]: "" }} className="flex min-h-0 flex-1 flex-col">
      {focus.kind === "task" ? (
        <TaskDetail owner={owner} task={task} taskSession={taskSession} project={project} />
      ) : (
        <NativeDetail owner={owner} focus={focus} task={task} taskSession={taskSession} project={project} />
      )}
    </div>
  );
}

type Project = NonNullable<ReturnType<typeof useProjects>["projects"][number]>;

/** 嵌套会话：完整的时间线和作曲栏，可以直接说话。 */
function TaskDetail({
  owner,
  task,
  taskSession,
  project,
}: {
  owner: string;
  task: TaskEntry;
  taskSession: TaskSession;
  project: Project | undefined;
}) {
  const chat = useTaskChat(task, taskSession, project, owner);
  const feed = chat.timeline.all;
  const composer = useLiveComposer({
    task,
    taskSession,
    session: chat.session,
    queue: feed.queue,
    draft: chat.draft,
    project,
    profiles: chat.profiles,
  });
  const status = subtaskStatus(task.attention);
  const { model, effort } = taskSession.options;
  return (
    <ChatHostProvider host={chat.host}>
      <DetailHeader
        owner={owner}
        agent={taskSession.agent}
        title={task.title.trim() || "子任务"}
        meta={[model, effort].filter(Boolean).join(" · ")}
        status={status.label}
        onStop={
          status.running || task.attention.state === "needs-input"
            ? () => void interruptTurn(taskSession.id).catch(showError)
            : undefined
        }
        onOpenAlone={() => openTask(task.id, task.projectId ?? null)}
      />
      <div className="flex min-h-0 flex-1 flex-col">
        <AnswerMarkdownHost>
          <ChatView
            session={chat.session}
            events={feed.events}
            eventsReady={feed.ready}
            starting={chat.starting}
            renderComposer={(anchorRef) =>
              chat.loaded ? (
                <Composer
                  key={chat.session.id}
                  host={composer}
                  session={chat.session}
                  events={chat.timeline.current.events}
                  anchorRef={anchorRef}
                />
              ) : null
            }
          />
        </AnswerMarkdownHost>
      </div>
    </ChatHostProvider>
  );
}

/** Agent 自带的子 Agent：只能看。 */
function NativeDetail({
  owner,
  focus,
  task,
  taskSession,
  project,
}: {
  owner: string;
  focus: Extract<SubagentFocus, { kind: "native" }>;
  task: TaskEntry;
  taskSession: TaskSession;
  project: Project | undefined;
}) {
  const chat = useTaskChat(task, taskSession, project, owner);
  const feed = chat.timeline.all;
  const card = useMemo(
    () => subagentCards(feed.events).find((item) => item.session_id === focus.sessionId && item.subagent_id === focus.subagentId),
    [feed.events, focus.sessionId, focus.subagentId],
  );
  // 这个子 Agent 的记录不在了，回到列表。
  useEffect(() => {
    if (feed.ready && !card) focusSubagent(owner, undefined);
  }, [card, feed.ready, owner]);
  if (!card) return null;
  const canStop = card.status === "running" && card.session_id === taskSession.id && Boolean(chat.profile?.capabilities.supports_subagent_stop);
  return (
    <ChatHostProvider host={chat.host}>
      <DetailHeader
        owner={owner}
        agent={taskSession.agent}
        title={subagentTitle(card)}
        meta={[card.model, card.effort].filter(Boolean).join(" · ")}
        onStop={canStop ? () => void stopSubagent(card.session_id, card.subagent_id).catch(showError) : undefined}
      />
      <div className="min-h-0 flex-1">
        <SubagentView card={card} events={feed.events} parent={chat.session} />
      </div>
    </ChatHostProvider>
  );
}

/** 「返回 · Agent 图标 · 标题 · 模型 · 强度 · 停止 · 单独打开」。 */
function DetailHeader({
  owner,
  agent,
  title,
  meta,
  status,
  onStop,
  onOpenAlone,
}: {
  owner: string;
  agent: AgentKind;
  title: string;
  meta: string;
  status?: string;
  onStop?: () => void;
  onOpenAlone?: () => void;
}) {
  const identity = useAgentIdentity(agent);
  const detail = meta || agentTurnName(agent, identity);
  return (
    <div data-subagent-header className="flex h-10 shrink-0 items-center gap-2 border-b border-[#222] px-2 text-[13px]">
      <HeaderButton label="返回列表" onClick={() => focusSubagent(owner, undefined)}>
        <ArrowLeft className="h-4 w-4" />
      </HeaderButton>
      <SessionAgentIcon identity={identity} className="h-4 w-4" />
      <span className="min-w-0 flex-1 truncate font-medium text-[#e4e4e4]">{title}</span>
      <span className="min-w-0 max-w-[45%] shrink truncate text-[12px] text-[#8a8a8a]">
        {[detail, status].filter(Boolean).join(" · ")}
      </span>
      {onStop ? (
        <HeaderButton label="停止" onClick={onStop}>
          <Square className="h-3 w-3" />
        </HeaderButton>
      ) : null}
      {onOpenAlone ? (
        <HeaderButton label="单独打开" onClick={onOpenAlone}>
          <ArrowUpRight className="h-4 w-4" />
        </HeaderButton>
      ) : null}
    </div>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#9a9a9a] hover:bg-white/[0.08] hover:text-[#e4e4e4]")}
    >
      {children}
    </button>
  );
}

// 聊天视图要从外面拿的东西。时间线和提问卡只认这个接口，不知道数据来自哪里。

import { createContext, useContext, type ReactNode } from "react";

import type { Attention } from "@/shared/attention";
import type { TextSnippetDraft } from "@/shared/text-snippet";
import type { AgentKind, AgentProfile, PromptAnswer } from "@/types";

export interface ChatHost {
  /** 回答审批、提问、计划选择。失败时返回 false，卡片重新可点。 */
  answerPrompt(sessionId: string, promptId: string, answer: PromptAnswer): Promise<boolean>;
  /** 各 Agent 的能力、显示名和图标。 */
  profiles: Partial<Record<AgentKind, AgentProfile>>;
  /** 项目主目录。工具路径相对会话工作目录显示，没有工作目录时用它。 */
  projectPath: string;
  /** 上滚取更早的回合，返回 true 表示到头。时间线已经完整的宿主不给。 */
  loadOlderHistory?: (sessionId: string) => Promise<boolean>;
  /** 把聊天记录里的选区放进作曲栏。不支持的宿主不给，选区菜单就不出现。 */
  addTextSnippet?: (sessionId: string, draft: TextSnippetDraft) => void;
  /** 时间线由几段会话接成时（中途换过 Agent），每段是哪个 Agent。只有一段的宿主不给。 */
  agentOf?: (sessionId: string) => AgentKind | undefined;
  /** 子任务的标题和跳转、开子任务卡片的选择。不支持的宿主不给，卡片就不能点。 */
  subtasks?: SubtaskHost;
  /** 打开 Agent 自带子 Agent 的视图。不支持的宿主不给，子 Agent 的行就不能点。 */
  openSubagent?: (sessionId: string, subagentId: string) => void;
}

/** 时间线里一行子任务要画的。 */
export interface SubtaskView {
  title: string;
  agent: AgentKind;
  attention: Attention;
  /** 现在这一回合开始的时间（毫秒），运行中时用来计时。 */
  since: number;
}

export interface SubtaskHost {
  /** 任务列表里还没有它时没有。 */
  title(taskId: string): string | undefined;
  /** 子任务现在的样子，跟着任务列表变。任务列表里还没有它时没有。 */
  useSubtask(taskId: string): SubtaskView | undefined;
  open(taskId: string): void;
  /** 放到右侧面板，和现在的会话并排看。 */
  openBeside(taskId: string): void;
  /** 失败时宿主自己报错，卡片重新可点。 */
  resolveOffer(sessionId: string, offerId: string, accept: boolean): Promise<void>;
}

const ChatHostContext = createContext<ChatHost | null>(null);

export function ChatHostProvider({ host, children }: { host: ChatHost; children: ReactNode }) {
  return <ChatHostContext.Provider value={host}>{children}</ChatHostContext.Provider>;
}

export function useChatHost(): ChatHost {
  const host = useContext(ChatHostContext);
  if (!host) throw new Error("聊天视图缺少 ChatHostProvider");
  return host;
}

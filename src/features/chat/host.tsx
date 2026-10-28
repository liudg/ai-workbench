// 聊天视图要从外面拿的东西。时间线和提问卡只认这个接口，不知道数据来自哪里。

import { createContext, useContext, type ReactNode } from "react";

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

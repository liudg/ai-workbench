import type { Session, SessionEvent } from "@/types";

export interface EventItemProps {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
  thinkingOpen?: boolean;
  onToggleThinking?: () => void;
  /** 一轮只在最终答复上标一次 Agent，旁白不再重复。折叠行已经写了名字时为 false。 */
  showAgentLabel?: boolean;
  /**
   * 时间与复制。进行中的正文、以及后面还有工具摘要的正文不带。
   * 缺省时跟 `showAgentLabel` 走。
   */
  showMessageFooter?: boolean;
}

export interface EventViewProps {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
  time: string;
  thinkingOpen: boolean;
  onToggleThinking: () => void;
  showAgentLabel: boolean;
  showMessageFooter?: boolean;
}

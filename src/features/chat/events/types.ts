import type { Session, SessionEvent } from "@/types";

export interface EventItemProps {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
  thinkingOpen?: boolean;
  onToggleThinking?: () => void;
  /** 一轮只在最终答复上标一次 Agent，旁白不再重复。 */
  showAgentLabel?: boolean;
}

export interface EventViewProps {
  event: SessionEvent;
  session: Session;
  resolvedAnswer: string | null;
  time: string;
  thinkingOpen: boolean;
  onToggleThinking: () => void;
  showAgentLabel: boolean;
}

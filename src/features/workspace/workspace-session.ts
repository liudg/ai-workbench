import type { Session } from "../../types/index.ts";
import { sessionFromDraft } from "../../store/draft-session.ts";
import type { SessionDraft } from "../../store/types.ts";

/**
 * 主区该看哪一条。
 * 项目里已经没有真实会话时，看这个项目的懒草稿，不再停在空状态页。
 * 列表还没载入时，只有用户正在看的草稿能占住主区。
 */
export function visibleWorkspaceSession(input: {
  sessions: readonly Session[] | undefined;
  activeSessionId: string | undefined;
  draft: SessionDraft | undefined;
  draftFocused: boolean;
}): Session | null {
  const live = input.sessions?.find((item) => item.id === input.activeSessionId) ?? null;
  const projectEmpty = input.sessions !== undefined && input.sessions.length === 0;
  if (input.draft && (input.draftFocused || projectEmpty)) {
    return sessionFromDraft(input.draft);
  }
  return live;
}

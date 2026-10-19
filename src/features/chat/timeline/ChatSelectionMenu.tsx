import type { RefObject } from "react";

import { addSessionTextSnippet } from "@/features/panel/core/useAddTextSnippet";
import { SelectionMenu } from "@/shared/selection/SelectionMenu";

import { chatDraftFromSelection } from "./chat-selection";

/** 聊天记录里的选区进当前会话的文本片。侧边提问没有界面，不放空项。 */
export function ChatSelectionMenu({
  rootRef,
  sessionId,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sessionId: string;
}) {
  return (
    <SelectionMenu
      rootRef={rootRef}
      readDraft={chatDraftFromSelection}
      onAdd={(draft) => {
        addSessionTextSnippet(sessionId, draft);
      }}
    />
  );
}

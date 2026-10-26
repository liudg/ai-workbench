import type { RefObject } from "react";

import { SelectionMenu } from "@/shared/selection/SelectionMenu";

import { useChatHost } from "../host";
import { chatDraftFromSelection } from "./chat-selection";

/** 聊天记录里的选区进当前会话的文本片。宿主不收文本片时不出现。 */
export function ChatSelectionMenu({
  rootRef,
  sessionId,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sessionId: string;
}) {
  const addTextSnippet = useChatHost().addTextSnippet;
  if (!addTextSnippet) return null;
  return (
    <SelectionMenu
      rootRef={rootRef}
      readDraft={chatDraftFromSelection}
      onAdd={(draft) => {
        addTextSnippet(sessionId, draft);
      }}
    />
  );
}

import { useEffect, useState, type RefObject } from "react";

import { SelectionMenu, type SelectionAction } from "@/shared/selection/SelectionMenu";
import { DESKTOP_ZH } from "@/shared/strings/desktop-zh";
import type { TextSnippetDraft } from "@/shared/text-snippet";

import { useChatHost } from "../host";
import { chatDraftFromSelection } from "./chat-selection";
import { ReplyBox } from "./ReplyBox";

/**
 * 聊天记录里选中一段后：「开始侧边对话」把它带进侧边聊天，「回复」写一句话连同原文放进作曲栏。
 * 两样都由宿主决定给不给，一样都没有时不出菜单。
 */
export function ChatSelectionMenu({
  rootRef,
  sessionId,
}: {
  rootRef: RefObject<HTMLElement | null>;
  sessionId: string;
}) {
  const { addTextSnippet, startSideChat } = useChatHost();
  const [reply, setReply] = useState<{ draft: TextSnippetDraft; range: Range | null } | null>(null);
  useEffect(() => setReply(null), [sessionId]);
  const actions = (): SelectionAction[] => {
    const list: SelectionAction[] = [];
    if (startSideChat) list.push({ id: "side-chat", label: DESKTOP_ZH.startSideChat, onSelect: startSideChat });
    if (addTextSnippet) {
      list.push({ id: "reply", label: DESKTOP_ZH.reply, onSelect: (draft, range) => setReply({ draft, range }) });
    }
    return list;
  };
  return (
    <>
      <SelectionMenu rootRef={rootRef} readDraft={chatDraftFromSelection} actions={actions} />
      {reply && addTextSnippet ? (
        <ReplyBox
          draft={reply.draft}
          range={reply.range}
          rootRef={rootRef}
          onSubmit={(draft) => {
            addTextSnippet(sessionId, draft);
            setReply(null);
          }}
          onCancel={() => setReply(null)}
        />
      ) : null}
    </>
  );
}

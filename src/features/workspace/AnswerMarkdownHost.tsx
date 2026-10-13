import { useMemo, type ReactNode } from "react";

import { MessageImage } from "@/features/chat/answer/MessageContent";
import { WebsiteCard } from "@/features/chat/cards/WebsiteCard";
import { usePanelOptional } from "@/features/panel/core/PanelProvider";
import { MarkdownHost, type MarkdownHostApi } from "@/shared/markdown/host";

/** 聊天和右侧预览共用的回答渲染。挂在已经有面板上下文的会话里。 */
export function AnswerMarkdownHost({ children }: { children: ReactNode }) {
  const preview = usePanelOptional();
  const api = useMemo<MarkdownHostApi>(
    () => ({
      canOpen: preview != null,
      openHref: (href, line) => preview?.openHref(href, line),
      renderImage: (alt, source) => <MessageImage alt={alt} source={source} />,
      renderWebsite: (href, label) => <WebsiteCard href={href} label={label} />,
    }),
    [preview],
  );
  return <MarkdownHost api={api}>{children}</MarkdownHost>;
}

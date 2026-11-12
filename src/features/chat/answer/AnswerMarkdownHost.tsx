import { useMemo, type ReactNode } from "react";

import { usePanelOptional } from "@/features/panel";
import { MarkdownHost, type MarkdownHostApi } from "@/shared/markdown/host";
import { WebsiteCard } from "../cards/WebsiteCard";
import { MessageImage } from "./MessageContent";

/** 聊天和右侧预览共用的回答渲染。挂在已经有面板上下文的会话里。 */
export function AnswerMarkdownHost({ children }: { children: ReactNode }) {
  const preview = usePanelOptional();
  const api = useMemo<MarkdownHostApi>(
    () => ({
      canOpen: preview != null,
      openHref: (href, line) => preview?.openHref(href, line),
      renderImage: (alt, source) => <MessageImage alt={alt} source={source} />,
      renderWebsite: (href, label) => <WebsiteCard href={href} label={label} />,
      runCommand: preview ? (command) => preview.runInTerminal(command) : undefined,
    }),
    [preview],
  );
  return <MarkdownHost api={api}>{children}</MarkdownHost>;
}

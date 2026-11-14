import { useMemo, type ReactNode } from "react";

import { usePanelOptional } from "@/features/panel";
import { isTauri } from "@/lib/daemon/endpoint";
import { openUrl } from "@/lib/native/open-path";
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
      // 有面板时在内置浏览器里开；桌面版没有面板就交给系统浏览器。
      openLink: preview ? (url) => preview.openHref(url) : isTauri ? (url) => void openUrl(url).catch(() => undefined) : undefined,
      runCommand: preview ? (command) => preview.runInTerminal(command) : undefined,
    }),
    [preview],
  );
  return <MarkdownHost api={api}>{children}</MarkdownHost>;
}

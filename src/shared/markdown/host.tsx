import { createContext, useContext, type ReactNode } from "react";

import type { ImageSource } from "./markdown-images";

/** 回答 Markdown 自己不打开文件、不读图片。宿主在会话里接上预览和图片。 */
export type MarkdownHostApi = {
  canOpen: boolean;
  openHref: (href: string, line?: number) => void;
  renderImage: (alt: string, source: ImageSource) => ReactNode;
  renderWebsite: (href: string, label: string) => ReactNode;
};

const MarkdownHostContext = createContext<MarkdownHostApi | null>(null);

export function MarkdownHost({
  api,
  children,
}: {
  api: MarkdownHostApi;
  children: ReactNode;
}) {
  return <MarkdownHostContext.Provider value={api}>{children}</MarkdownHostContext.Provider>;
}

export function useMarkdownHost(): MarkdownHostApi | null {
  return useContext(MarkdownHostContext);
}

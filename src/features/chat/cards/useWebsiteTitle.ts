import { useEffect, useState } from "react";

import { usePanelOptional } from "@/features/panel";
import { pageTitleFromHtml } from "@/shared/html-title";

/** 本地 html 的标题。外链不读文件。 */
export function useWebsiteTitle(href: string, label: string): string {
  const panel = usePanelOptional();
  const data = panel?.data;
  const projectId = panel?.projectId ?? "";
  const sessionId = panel?.sessionId ?? "";
  const [title, setTitle] = useState(label);
  useEffect(() => {
    setTitle(label);
    if (!data || /^https?:\/\//i.test(href)) return;
    let cancel = false;
    void data
      .readPreviewFile(projectId, href, sessionId)
      .then((doc) => {
        if (cancel) return;
        const parsed = pageTitleFromHtml(doc.text);
        if (parsed) setTitle(parsed);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [data, href, label, projectId, sessionId]);
  return title;
}

import { useEffect, useState } from "react";

import { backend } from "@/lib/ipc";
import { pageTitleFromHtml } from "@/shared/html-title";

/** 本地 html 的标题。外链不读文件。 */
export function useWebsiteTitle(projectId: string, href: string, label: string): string {
  const [title, setTitle] = useState(label);
  useEffect(() => {
    setTitle(label);
    if (!projectId || /^https?:\/\//i.test(href)) return;
    let cancel = false;
    void backend
      .readPreviewFile(projectId, href)
      .then((doc) => {
        if (cancel) return;
        const parsed = pageTitleFromHtml(doc.text);
        if (parsed) setTitle(parsed);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [href, label, projectId]);
  return title;
}

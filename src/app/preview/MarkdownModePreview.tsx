import { FileText } from "lucide-react";

import { markdownViewer } from "@/features/panel";

const SAMPLE = `# 宝石说明

这是预览里的**粗体**和一条列表。

- 第一项
- 第二项

public class Gem { int n = 4; // note
`;

/** 开发预览：中间面板里的 Markdown 源码/预览切换。不写进安装包。 */
export default function MarkdownModePreview() {
  const View = markdownViewer.View;
  return (
    <div className="flex h-screen w-screen items-stretch bg-wb-shell text-wb-fg">
      <section data-preview-panel className="flex h-full min-w-0 flex-1 flex-col border-l border-wb-border bg-wb-surface">
        <div className="flex h-11 shrink-0 items-center border-b border-wb-border px-1.5">
          <div className="my-1.5 flex min-w-0 max-w-[180px] items-center rounded-md bg-wb-active text-wb-fg">
            <span className="flex min-w-0 items-center gap-1 px-2 py-1.5 text-xs">
              <FileText className="h-3.5 w-3.5" />
              <span className="truncate">宝石说明.md</span>
            </span>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-hidden">
          <View
            tabId="preview-md"
            sessionId="preview"
            projectId="preview"
            status="ready"
            setTitle={() => {}}
            payload={{
              title: "宝石说明.md",
              path: "notes/宝石说明.md",
              text: SAMPLE,
              truncated: false,
            }}
          />
        </div>
      </section>
    </div>
  );
}

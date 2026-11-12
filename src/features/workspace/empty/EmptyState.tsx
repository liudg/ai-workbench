import { FolderOpen, FolderPlus, MessageSquarePlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEmptyProject } from "./use-empty-project";

export function NoProjectSelected() {
  const { openDialog, startStandalone } = useEmptyProject();
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-wb-border bg-wb-elev text-wb-fg-2">
        <FolderOpen className="h-5 w-5" strokeWidth={1.8} />
      </div>
      <h2 className="mt-4 text-base font-semibold tracking-tight text-wb-fg">打开项目开始工作</h2>
      <p className="mt-1.5 max-w-80 text-[13px] leading-5 text-wb-fg-2">
        导入本地代码目录，在同一工作台并行调用多个 Agent。
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => openDialog("import")}>
          <FolderOpen className="h-4 w-4" />
          导入项目目录
        </Button>
        <Button variant="secondary" onClick={() => openDialog("create")}>
          <FolderPlus className="h-4 w-4" />
          新建空项目
        </Button>
      </div>
      <button
        type="button"
        onClick={startStandalone}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs text-wb-fg-3 transition-colors hover:bg-wb-hover hover:text-wb-fg-2"
      >
        <MessageSquarePlus className="h-3.5 w-3.5" />
        不绑定项目，直接新建对话
      </button>
    </div>
  );
}
